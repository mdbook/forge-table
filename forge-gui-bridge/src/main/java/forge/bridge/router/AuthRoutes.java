package forge.bridge.router;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import forge.bridge.BridgeLog;
import forge.bridge.auth.LoginThrottle;
import forge.bridge.auth.OidcLogin;
import forge.bridge.auth.Pbkdf2Hasher;
import forge.bridge.auth.Sessions;
import forge.bridge.auth.UserStore;
import io.netty.channel.ChannelHandlerContext;
import io.netty.handler.codec.http.FullHttpRequest;
import io.netty.handler.codec.http.HttpHeaderNames;
import io.netty.handler.codec.http.HttpMethod;
import io.netty.handler.codec.http.HttpResponseStatus;
import io.netty.handler.codec.http.QueryStringDecoder;

/**
 * Native sign-in's pages and calls (--auth users, oidc): {@code GET /auth/login} (the sign-in page, a Vite entry in the
 * web build), {@code POST /auth/login}, {@code POST /auth/logout}, {@code GET /auth/methods} (what the sign-in page
 * offers), and for OIDC {@code GET /auth/oidc/start} and {@code GET /auth/oidc/callback}. Every POST passes
 * {@link Router#strictSameOrigin} (login CSRF too). Password checks and calls to the OIDC provider run off the event
 * loop: one is a deliberate fraction of a second of CPU, the other a network round trip.
 */
final class AuthRoutes {
    /** Same words for "no such user" and "wrong password", so the answer doesn't say which logins exist. */
    static final String WRONG = "Wrong username or password.";

    private final Router router;
    private final Router.Options o;
    private final UserStore users;
    private final Sessions sessions;
    private final LoginThrottle throttle;
    /** --auth oidc, else null. */
    private final OidcLogin oidc;
    /** Where password checks run: two at a time, a short queue, and "busy" past that. */
    private final ThreadPoolExecutor checks = new ThreadPoolExecutor(2, 2, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(32), r -> {
        final Thread t = new Thread(r, "router-signin");
        t.setDaemon(true);
        return t;
    });
    /** Where OIDC sign-ins talk to the provider: a slow provider can't hold up password checks. */
    private final ThreadPoolExecutor provider = new ThreadPoolExecutor(4, 4, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(64), r -> {
        final Thread t = new Thread(r, "router-oidc");
        t.setDaemon(true);
        return t;
    });

    AuthRoutes(final Router router, final Router.Options o, final UserStore users, final Sessions sessions, final OidcLogin oidc) {
        this.router = router;
        this.o = o;
        this.users = users;
        this.sessions = sessions;
        this.oidc = oidc;
        this.throttle = new LoginThrottle(o.clock);
    }

    /** Whether the sign-in page has a username and password form (--auth users). */
    private boolean passwords() {
        return o.auth.contains("users");
    }

    /** What the log should say once at startup: no accounts yet, or cookies without Secure. */
    void startupNotes() {
        try {
            if (passwords() && users.users().isEmpty()) {
                BridgeLog.info("no accounts yet: add the first admin with  forge.bridge.Main --users add <login> --admin");
            }
        } catch (final SQLException e) {
            BridgeLog.warn("cannot read accounts: " + e.getMessage());
        }
        if (o.insecureCookies) {
            BridgeLog.warn("--insecure-cookies: session cookies go over plain http too. Only on a network you trust; put TLS in front otherwise.");
        }
        if (o.oidcInsecure) {
            BridgeLog.warn("--oidc-insecure: the provider may be plain http, so anyone on the path can sign in as anyone. For a local test provider only.");
        }
        if (o.linkByLogin) {
            BridgeLog.warn("--link-by-login is on: an OIDC sign-in takes the account with the same login. Turn it off once everyone has signed in.");
        }
        if (oidc != null) {
            provider.execute(oidc::check);
        }
    }

    void close() {
        checks.shutdownNow();
        provider.shutdownNow();
    }

    void handle(final ChannelHandlerContext ctx, final FullHttpRequest req, final QueryStringDecoder q, final String path) throws IOException {
        final HttpMethod m = req.method();
        if (path.equals("/auth/login") && (m == HttpMethod.GET || m == HttpMethod.HEAD)) {
            final List<String> next = q.parameters().get("next");
            if (signedIn(req)) {
                Router.redirect(ctx, safeNext(next == null || next.isEmpty() ? null : next.get(0)));
            } else {
                router.webFile(ctx, req, "login.html", "/");
            }
        } else if (path.equals("/auth/methods") && m == HttpMethod.GET) {
            final JsonObject methods = new JsonObject();
            methods.addProperty("password", passwords());
            if (oidc != null) {
                final JsonObject button = new JsonObject();
                button.addProperty("label", o.oidcLabel);
                button.addProperty("start", "/auth/oidc/start");
                methods.add("oidc", button);
            }
            Router.sendJson(ctx, req, HttpResponseStatus.OK, methods);
        } else if (oidc != null && path.equals("/auth/oidc/start") && m == HttpMethod.GET) {
            oidcStart(ctx, q);
        } else if (oidc != null && path.equals("/auth/oidc/callback") && m == HttpMethod.GET) {
            oidcCallback(ctx, req, q);
        } else if ((path.equals("/auth/login") || path.equals("/auth/logout")) && m == HttpMethod.POST) {
            if (!router.strictSameOrigin(req)) {
                Router.sendText(ctx, HttpResponseStatus.FORBIDDEN, "Forbidden origin");
            } else if (path.equals("/auth/login")) {
                if (passwords()) {
                    login(ctx, req);
                } else {
                    Router.sendError(ctx, req, HttpResponseStatus.NOT_FOUND, "This Forge Table has no password sign-in.");
                }
            } else {
                logout(ctx, req);
            }
        } else if (path.equals("/auth/login") || path.equals("/auth/logout") || path.equals("/auth/methods")) {
            Router.sendText(ctx, HttpResponseStatus.METHOD_NOT_ALLOWED, "method not allowed");
        } else {
            Router.sendPage(ctx, req, HttpResponseStatus.NOT_FOUND, "Page not found", "Nothing lives at this address.");
        }
    }

    private boolean signedIn(final FullHttpRequest req) {
        try {
            return sessions.find(sessions.cookie(req.headers().getAll(HttpHeaderNames.COOKIE))) != null;
        } catch (final SQLException e) {
            return false;
        }
    }

    /** {@code POST /auth/login} {@code {"login", "password", "next"}}: a session cookie and where to go, or why not. */
    private void login(final ChannelHandlerContext ctx, final FullHttpRequest req) {
        final String login;
        final String password;
        final String next;
        try {
            final JsonObject body = JsonParser.parseString(req.content().toString(StandardCharsets.UTF_8)).getAsJsonObject();
            login = string(body, "login");
            password = string(body, "password");
            next = safeNext(string(body, "next"));
        } catch (final RuntimeException e) {
            Router.sendError(ctx, req, HttpResponseStatus.BAD_REQUEST, "Send {\"login\": ..., \"password\": ...}.");
            return;
        }
        if (login == null || password == null || login.length() > 256 || password.length() > Pbkdf2Hasher.MAX_LENGTH * 4) {
            Router.sendError(ctx, req, HttpResponseStatus.BAD_REQUEST, "Enter your username and password.");
            return;
        }
        final String key = login.trim().toLowerCase(Locale.ROOT);
        final String address = router.clientIp(ctx, req);
        final String oldCookie = sessions.cookie(req.headers().getAll(HttpHeaderNames.COOKIE));
        final String userAgent = req.headers().get(HttpHeaderNames.USER_AGENT);
        // the slot is taken right before the task is queued, so every path from here on ends it
        if (!throttle.begin(key, address)) {
            BridgeLog.warn("sign-in throttled for " + key + " from " + address);
            Router.sendError(ctx, req, HttpResponseStatus.TOO_MANY_REQUESTS, "Too many tries. Wait a few minutes and try again.");
            return;
        }
        req.retain();
        try {
            checks.execute(() -> {
                Answer a;
                try {
                    a = check(key, login, password, address, oldCookie, userAgent, next);
                } catch (final RuntimeException e) {
                    BridgeLog.warn("sign-in failed: " + e);
                    a = error(HttpResponseStatus.INTERNAL_SERVER_ERROR, "Signing in isn't working right now. Try again in a moment.");
                } finally {
                    throttle.end(key, address);
                }
                final Answer answer = a;
                ctx.executor().execute(() -> {
                    try {
                        Router.sendJson(ctx, req, answer.status, answer.body, answer.cookie);
                    } finally {
                        req.release();
                    }
                });
            });
        } catch (final RejectedExecutionException e) {
            throttle.end(key, address);
            req.release();
            Router.sendError(ctx, req, HttpResponseStatus.SERVICE_UNAVAILABLE, "Signing in is busy right now. Try again in a moment.");
        }
    }

    private record Answer(HttpResponseStatus status, JsonElement body, String cookie) { }

    /** The password check and the session, on {@link #checks}. */
    private Answer check(final String key, final String login, final String password, final String address, final String oldCookie,
            final String userAgent, final String next) {
        try {
            final String local = UserStore.localLogin(login);
            final UserStore.User u = local == null ? null : users.user(local);
            if (!Pbkdf2Hasher.verify(password, u == null ? null : u.passwordHash())) {
                throttle.failed(key, address);
                BridgeLog.info("sign-in failed for " + key + " from " + address);
                return error(HttpResponseStatus.UNAUTHORIZED, WRONG);
            }
            if (u.disabled()) {
                return error(HttpResponseStatus.FORBIDDEN, "This account is turned off. Ask an admin to turn it back on.");
            }
            throttle.succeeded(key);
            if (Pbkdf2Hasher.outdated(u.passwordHash())) {
                users.rehash(u.id(), Pbkdf2Hasher.hash(password));
            }
            final UserStore.Session old = users.session(oldCookie);
            if (old != null) {
                users.endSession(old.idHash()); // a new id on every sign-in, never the one the browser came with
            }
            final String id = sessions.open(u, userAgent, false);
            BridgeLog.info("signed in: " + u.login() + " from " + address);
            final JsonObject ok = new JsonObject();
            ok.addProperty("next", next);
            return new Answer(HttpResponseStatus.OK, ok, sessions.setCookie(id));
        } catch (final SQLException e) {
            BridgeLog.warn("sign-in failed: " + e.getMessage());
            return error(HttpResponseStatus.SERVICE_UNAVAILABLE, "Signing in isn't working right now. Try again in a moment.");
        }
    }

    // ---------------------------------------------------------------- OIDC

    /** {@code GET /auth/oidc/start?next=}: off to the provider, with a pre-login cookie to come back with. */
    private void oidcStart(final ChannelHandlerContext ctx, final QueryStringDecoder q) {
        final String next = safeNext(param(q, "next"));
        try {
            provider.execute(() -> {
                String location;
                String cookie = null;
                try {
                    final OidcLogin.Start s = oidc.start(next);
                    location = s.location();
                    cookie = sessions.setPreLogin(s.cookie(), OidcLogin.PENDING_MS);
                } catch (final OidcLogin.Failure f) {
                    BridgeLog.warn("OIDC sign-in can't start: " + f.getMessage());
                    location = failed(f.code, next);
                }
                final String to = location;
                final String[] cookies = cookie == null ? new String[0] : new String[] {cookie};
                ctx.executor().execute(() -> Router.redirect(ctx, to, cookies));
            });
        } catch (final RejectedExecutionException e) {
            Router.redirect(ctx, failed("busy", next));
        }
    }

    /** {@code GET /auth/oidc/callback}: the provider sent the browser back; a session, or the sign-in page with why not. */
    private void oidcCallback(final ChannelHandlerContext ctx, final FullHttpRequest req, final QueryStringDecoder q) {
        final List<String> cookies = req.headers().getAll(HttpHeaderNames.COOKIE);
        final String preLogin = sessions.preLogin(cookies);
        final String oldCookie = sessions.cookie(cookies);
        final String userAgent = req.headers().get(HttpHeaderNames.USER_AGENT);
        final String address = router.clientIp(ctx, req);
        final String state = param(q, "state");
        final String code = param(q, "code");
        final String error = param(q, "error");
        final String iss = param(q, "iss");
        try {
            provider.execute(() -> {
                String location;
                String session = null;
                try {
                    final OidcLogin.Done d = oidc.finish(state, code, error, iss, preLogin);
                    final Answer a = external(d.identity(), address, oldCookie, userAgent);
                    if (a.cookie != null) {
                        location = safeNext(d.next());
                        session = a.cookie;
                    } else {
                        location = failed(a.body.getAsJsonObject().get("error").getAsString(), safeNext(d.next()));
                    }
                } catch (final OidcLogin.Failure f) {
                    BridgeLog.warn("OIDC sign-in failed from " + address + ": " + f.getMessage());
                    location = failed(f.code, "/");
                } catch (final RuntimeException e) {
                    BridgeLog.warn("OIDC sign-in failed: " + e);
                    location = failed("provider", "/");
                }
                final String to = location;
                final String[] set = session == null ? new String[] {sessions.clearPreLogin()} : new String[] {session, sessions.clearPreLogin()};
                ctx.executor().execute(() -> Router.redirect(ctx, to, set));
            });
        } catch (final RejectedExecutionException e) {
            Router.redirect(ctx, failed("busy", "/"));
        }
    }

    /**
     * A session for someone the provider vouched for (see {@link UserStore#external}), or an error code for the sign-in
     * page: {@code group} (not in --require-group), {@code taken} (the login is another account's), {@code off}.
     */
    private Answer external(final OidcLogin.Identity id, final String address, final String oldCookie, final String userAgent) {
        if (o.requireGroup != null && !id.groups().contains(o.requireGroup)) {
            BridgeLog.info("OIDC sign-in refused for " + id.login() + ": not in group " + o.requireGroup);
            return error(HttpResponseStatus.FORBIDDEN, "group");
        }
        try {
            final UserStore.External r = users.external(id.provider(), id.subject(), id.login(), Router.guestName(id.name()), o.linkByLogin,
                    o.clock.getAsLong());
            switch (r.outcome()) {
                case TAKEN -> {
                    BridgeLog.warn("OIDC sign-in refused: the login " + id.login() + " belongs to an account not linked to " + id.provider()
                            + ". If it's the same person: forge.bridge.Main --users link " + id.login() + " " + id.provider() + " " + id.subject());
                    return error(HttpResponseStatus.FORBIDDEN, "taken");
                }
                case NEW -> BridgeLog.info("new account " + id.login() + " from " + id.provider());
                case LINKED_BY_LOGIN -> BridgeLog.warn("linked the account " + id.login() + " to " + id.provider() + " by its login (--link-by-login)");
                default -> { }
            }
            final UserStore.User u = r.user();
            if (u.disabled()) {
                BridgeLog.info("OIDC sign-in refused for " + u.login() + ": the account is turned off");
                return error(HttpResponseStatus.FORBIDDEN, "off");
            }
            final UserStore.Session old = users.session(oldCookie);
            if (old != null) {
                users.endSession(old.idHash()); // a new id on every sign-in, never the one the browser came with
            }
            final boolean groupAdmin = o.adminGroup != null && id.groups().contains(o.adminGroup);
            final String sid = sessions.open(u, userAgent, groupAdmin);
            BridgeLog.info("signed in: " + u.login() + " with " + id.provider() + " from " + address + (groupAdmin ? " (admin by group)" : ""));
            return new Answer(HttpResponseStatus.OK, new JsonObject(), sessions.setCookie(sid));
        } catch (final SQLException e) {
            BridgeLog.warn("OIDC sign-in failed: " + e.getMessage());
            return error(HttpResponseStatus.SERVICE_UNAVAILABLE, "provider");
        }
    }

    /** The sign-in page saying why ({@code ?error=oidc-<code>}), keeping where the person was going. */
    private static String failed(final String code, final String next) {
        return "/auth/login?error=oidc-" + code + (next == null || next.equals("/") ? "" : "&next=" + java.net.URLEncoder.encode(next, StandardCharsets.UTF_8));
    }

    private static String param(final QueryStringDecoder q, final String key) {
        final List<String> v = q.parameters().get(key);
        return v == null || v.size() != 1 ? null : v.get(0);
    }

    private static Answer error(final HttpResponseStatus status, final String message) {
        final JsonObject e = new JsonObject();
        e.addProperty("error", message);
        return new Answer(status, e, null);
    }

    /**
     * {@code POST /auth/logout}: ends this browser's session (if any) and clears the cookie. With --oidc-logout provider
     * the answer also has {@code endSession}, the provider's sign-out page, which sends the browser back to ours.
     */
    private void logout(final ChannelHandlerContext ctx, final FullHttpRequest req) {
        String endSession = null;
        try {
            final UserStore.Session s = users.session(sessions.cookie(req.headers().getAll(HttpHeaderNames.COOKIE)));
            if (s != null) {
                users.endSession(s.idHash());
                BridgeLog.info("signed out: " + s.user().login());
                // --oidc-logout provider: someone with a link to the provider signs out there too
                if (oidc != null && o.oidcLogout.equals("provider")
                        && users.links(s.user().id()).stream().anyMatch(l -> l.provider().equals(oidc.provider()))) {
                    endSession = oidc.endSession(o.publicUrl + "/auth/login");
                }
            }
        } catch (final SQLException e) {
            BridgeLog.warn("sign-out: " + e.getMessage());
        }
        final JsonObject res = new JsonObject();
        res.addProperty("next", "/auth/login");
        if (endSession != null) {
            res.addProperty("endSession", endSession);
        }
        Router.sendJson(ctx, req, HttpResponseStatus.OK, res, sessions.clearCookie());
    }

    private static String string(final JsonObject body, final String key) {
        final JsonElement e = body.get(key);
        return e == null || e.isJsonNull() ? null : e.getAsString();
    }

    /**
     * Where to go after signing in: a path on this site ({@code /} and one more character that isn't {@code /} or
     * {@code \}, no control characters or spaces, at most 512 characters, not the sign-in pages themselves), else {@code /}.
     * Never another site: no scheme, no {@code //host}.
     */
    static String safeNext(final String next) {
        if (next == null || next.length() > 512 || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")
                || next.chars().anyMatch(c -> c <= 0x20 || c == 0x7f || c == '\\') || next.startsWith("/auth/") || next.equals("/auth")) {
            return "/";
        }
        return next;
    }
}
