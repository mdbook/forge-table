package forge.bridge.net;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Map;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import forge.bridge.BridgeApp;
import forge.bridge.BridgeLog;
import forge.bridge.NeuralStatus;
import forge.bridge.art.CardArtService;
import io.netty.bootstrap.ServerBootstrap;
import io.netty.buffer.ByteBuf;
import io.netty.buffer.Unpooled;
import io.netty.channel.Channel;
import io.netty.channel.ChannelFutureListener;
import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.ChannelInitializer;
import io.netty.channel.EventLoopGroup;
import io.netty.channel.SimpleChannelInboundHandler;
import io.netty.channel.nio.NioEventLoopGroup;
import io.netty.channel.socket.SocketChannel;
import io.netty.channel.socket.nio.NioServerSocketChannel;
import io.netty.handler.codec.http.DefaultFullHttpResponse;
import io.netty.handler.codec.http.FullHttpRequest;
import io.netty.handler.codec.http.FullHttpResponse;
import io.netty.handler.codec.http.HttpHeaderNames;
import io.netty.handler.codec.http.HttpHeaderValues;
import io.netty.handler.codec.http.HttpMethod;
import io.netty.handler.codec.http.HttpObjectAggregator;
import io.netty.handler.codec.http.HttpResponseStatus;
import io.netty.handler.codec.http.HttpServerCodec;
import io.netty.handler.codec.http.HttpUtil;
import io.netty.handler.codec.http.HttpVersion;
import io.netty.handler.codec.http.QueryStringDecoder;
import io.netty.handler.codec.http.websocketx.CloseWebSocketFrame;
import io.netty.handler.codec.http.websocketx.TextWebSocketFrame;
import io.netty.handler.codec.http.websocketx.WebSocketFrameAggregator;
import io.netty.handler.codec.http.websocketx.WebSocketServerProtocolConfig;
import io.netty.handler.codec.http.websocketx.WebSocketServerProtocolHandler;

/**
 * Loopback HTTP + WebSocket server: the web bundle at {@code /}, card images at {@code /img},
 * licence texts at {@code /licenses}, and the JSON protocol at {@code /ws}.
 *
 * <p>The WebSocket's first frame must be a {@code hello} carrying the session token; anything else closes
 * the connection. Upgrades from a browser {@code Origin} other than this server are refused. Data
 * endpoints ({@code /img}) need the token as the {@code ft} cookie or {@code t} query parameter.
 */
public final class BridgeServer {

    static final int MAX_FRAME = 16 * 1024 * 1024;
    /** How long an image request waits on a download before answering 503 + Retry-After. */
    static final int IMAGE_HOLD_SECONDS = 15;
    /** The artist of an art crop (/img/crop/…), percent-encoded UTF-8. */
    public static final String ARTIST_HEADER = "X-Card-Artist";
    /**
     * {@code /img/avatar/neural}: the Neural AI's picture ({@link NeuralStatus#avatar()}), else the art crop of its
     * {@link NeuralStatus#avatarCard()} (served as {@code /img/crop/} would), 404 when there is none.
     */
    static final String AVATAR = "avatar/neural";
    /** How long a browser keeps the Neural AI's picture (the router's lobby copy too). */
    public static final String AVATAR_CACHE = "private, max-age=3600";

    private static final Map<String, String> MIME = Map.ofEntries(
            Map.entry("html", "text/html; charset=utf-8"), Map.entry("js", "text/javascript; charset=utf-8"),
            Map.entry("mjs", "text/javascript; charset=utf-8"), Map.entry("css", "text/css; charset=utf-8"),
            Map.entry("json", "application/json"), Map.entry("svg", "image/svg+xml"), Map.entry("png", "image/png"),
            Map.entry("jpg", "image/jpeg"), Map.entry("jpeg", "image/jpeg"), Map.entry("webp", "image/webp"),
            Map.entry("woff2", "font/woff2"), Map.entry("woff", "font/woff"), Map.entry("txt", "text/plain; charset=utf-8"),
            Map.entry("ogg", "audio/ogg"), Map.entry("mp3", "audio/mpeg"), Map.entry("wav", "audio/wav"),
            Map.entry("ico", "image/x-icon"), Map.entry("map", "application/json"),
            Map.entry("webmanifest", "application/manifest+json"));

    private final BridgeApp app;
    private final File webDir;          // null: serve from the classpath bundle
    private EventLoopGroup boss;
    private EventLoopGroup workers;
    private Channel channel;
    private int port;

    public BridgeServer(final BridgeApp app, final File webDir) {
        this.app = app;
        this.webDir = webDir;
    }

    public int port() {
        return port;
    }

    public void start(final int requestedPort) throws InterruptedException {
        boss = new NioEventLoopGroup(1, named("netty-boss"));
        workers = new NioEventLoopGroup(2, named("netty-io"));
        final ServerBootstrap b = new ServerBootstrap()
                .group(boss, workers)
                .channel(NioServerSocketChannel.class)
                .childHandler(new ChannelInitializer<SocketChannel>() {
                    @Override
                    protected void initChannel(final SocketChannel ch) {
                        ch.pipeline().addLast(new HttpServerCodec());
                        ch.pipeline().addLast(new HttpObjectAggregator(1 << 20));
                        ch.pipeline().addLast(new UpgradeGuard());
                        ch.pipeline().addLast(new WebSocketServerProtocolHandler(WebSocketServerProtocolConfig.newBuilder()
                                .websocketPath("/ws").maxFramePayloadLength(MAX_FRAME).checkStartsWith(false).build()));
                        ch.pipeline().addLast(new WebSocketFrameAggregator(MAX_FRAME));
                        ch.pipeline().addLast(new WsHandler());
                        ch.pipeline().addLast(new HttpHandler());
                    }
                });
        channel = b.bind(new InetSocketAddress("127.0.0.1", requestedPort)).sync().channel();
        port = ((InetSocketAddress) channel.localAddress()).getPort();
    }

    public void stop() {
        if (channel != null) {
            channel.close();
        }
        if (boss != null) {
            boss.shutdownGracefully();
        }
        if (workers != null) {
            workers.shutdownGracefully();
        }
    }

    private static ThreadFactory named(final String prefix) {
        final AtomicInteger n = new AtomicInteger();
        return r -> {
            final Thread t = new Thread(r, prefix + "-" + n.incrementAndGet());
            t.setDaemon(true);
            return t;
        };
    }

    /** Refuses WebSocket upgrades from foreign browser origins. */
    private final class UpgradeGuard extends SimpleChannelInboundHandler<FullHttpRequest> {
        UpgradeGuard() {
            super(false);
        }

        @Override
        protected void channelRead0(final ChannelHandlerContext ctx, final FullHttpRequest req) {
            if (req.uri().startsWith("/ws")) {
                final String origin = req.headers().get(HttpHeaderNames.ORIGIN);
                if (origin != null && !origin.equals("http://127.0.0.1:" + port) && !origin.equals("http://localhost:" + port)
                        && !isDevOrigin(origin)) {
                    BridgeLog.warn("Refused WebSocket upgrade from origin " + origin);
                    req.release();
                    sendStatus(ctx, HttpResponseStatus.FORBIDDEN, "Forbidden origin");
                    return;
                }
            }
            ctx.fireChannelRead(req);
        }
    }

    /** Vite's dev server (only when the sidecar was told to trust it). */
    private static boolean isDevOrigin(final String origin) {
        final String dev = System.getProperty("forge.bridge.devOrigin");
        return dev != null && dev.equals(origin);
    }

    private final class WsHandler extends SimpleChannelInboundHandler<TextWebSocketFrame> {
        private java.util.function.Consumer<String> sink;

        @Override
        protected void channelRead0(final ChannelHandlerContext ctx, final TextWebSocketFrame frame) {
            final JsonObject msg;
            try {
                msg = JsonParser.parseString(frame.text()).getAsJsonObject();
            } catch (final RuntimeException e) {
                BridgeLog.warn("Bad frame: " + e.getMessage());
                return;
            }
            if (sink == null) {
                final boolean ok = msg.has("t") && "hello".equals(msg.get("t").getAsString())
                        && msg.has("token") && app.token().equals(msg.get("token").getAsString());
                if (!ok) {
                    ctx.writeAndFlush(new CloseWebSocketFrame(4001, "unauthorized")).addListener(ChannelFutureListener.CLOSE);
                    return;
                }
                final Channel ch = ctx.channel();
                final java.util.function.Consumer<String> newSink = json -> {
                    if (ch.isActive()) {
                        ch.writeAndFlush(new TextWebSocketFrame(json));
                    }
                };
                sink = newSink;
                if (!app.onHello(newSink, msg)) {
                    sink = null;
                    ctx.writeAndFlush(new CloseWebSocketFrame(4001, "unauthorized")).addListener(ChannelFutureListener.CLOSE);
                }
                return;
            }
            try {
                app.onMessage(sink, msg);
            } catch (final RuntimeException e) {
                BridgeLog.error("Message handling failed: " + msg, e);
            }
        }

        @Override
        public void channelInactive(final ChannelHandlerContext ctx) throws Exception {
            if (sink != null) {
                app.onClose(sink);
            }
            super.channelInactive(ctx);
        }
    }

    private final class HttpHandler extends SimpleChannelInboundHandler<FullHttpRequest> {
        @Override
        protected void channelRead0(final ChannelHandlerContext ctx, final FullHttpRequest req) throws IOException {
            final QueryStringDecoder q = new QueryStringDecoder(req.uri());
            final String path = q.path();
            if (path.equals("/seat/concede")) {
                seatConcede(ctx, req, q);
                return;
            }
            if (req.method() != HttpMethod.GET && req.method() != HttpMethod.HEAD) {
                sendStatus(ctx, HttpResponseStatus.METHOD_NOT_ALLOWED, "GET only");
                return;
            }
            if (path.equals("/status")) {
                // The match state for router mode's reaper: waiting | playing | over.
                if (!authorized(req, q)) {
                    sendStatus(ctx, HttpResponseStatus.UNAUTHORIZED, "token required");
                    return;
                }
                // ... and the table for the lobby's game card, once a game is dealt.
                final JsonObject st = new JsonObject();
                st.addProperty("state", app.state());
                final JsonObject table = app.table();
                if (table != null) {
                    st.add("table", table);
                }
                final JsonArray results = app.results(); // the games that ended here, for the router's results store
                if (!results.isEmpty()) {
                    st.add("results", results);
                }
                send(ctx, req, st.toString().getBytes(StandardCharsets.UTF_8), "application/json", "no-store");
                return;
            }
            if (path.startsWith("/img/")) {
                if (!authorized(req, q)) {
                    sendStatus(ctx, HttpResponseStatus.UNAUTHORIZED, "token required");
                    return;
                }
                serveImage(ctx, req, URLDecoder.decode(path.substring("/img/".length()), StandardCharsets.UTF_8));
                return;
            }
            String rel = path.equals("/") ? "index.html" : path.substring(1);
            if (rel.startsWith("licenses")) {
                rel = rel.equals("licenses") || rel.equals("licenses/") ? "THIRD-PARTY-NOTICES.txt" : rel.substring("licenses/".length());
            }
            if (rel.contains("..") || rel.contains("\\")) {
                sendStatus(ctx, HttpResponseStatus.BAD_REQUEST, "bad path");
                return;
            }
            final byte[] body = readWeb(webDir, rel);
            if (body == null) {
                sendStatus(ctx, HttpResponseStatus.NOT_FOUND, "not found");
                return;
            }
            send(ctx, req, body, mime(rel), rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache");
        }

        /**
         * {@code POST /seat/concede?seat=N} (token required): the router's DELETE of a pvp game that is being played. That
         * seat concedes; {@code {"conceded": false}} when no match is in progress (the router then ends the game).
         */
        private void seatConcede(final ChannelHandlerContext ctx, final FullHttpRequest req, final QueryStringDecoder q) {
            if (req.method() != HttpMethod.POST) {
                sendStatus(ctx, HttpResponseStatus.METHOD_NOT_ALLOWED, "POST only");
                return;
            }
            if (!authorized(req, q)) {
                sendStatus(ctx, HttpResponseStatus.UNAUTHORIZED, "token required");
                return;
            }
            final var seat = q.parameters().get("seat");
            if (seat == null || seat.size() != 1 || !seat.get(0).matches("[01]")) {
                sendStatus(ctx, HttpResponseStatus.BAD_REQUEST, "seat is 0 or 1");
                return;
            }
            final boolean conceded = app.concedeSeat(Integer.parseInt(seat.get(0)));
            send(ctx, req, ("{\"conceded\":" + conceded + "}").getBytes(StandardCharsets.UTF_8), "application/json", "no-store");
        }

        private boolean authorized(final FullHttpRequest req, final QueryStringDecoder q) {
            final var t = q.parameters().get("t");
            if (t != null && !t.isEmpty() && app.token().equals(t.get(0))) {
                return true;
            }
            final String cookie = req.headers().get(HttpHeaderNames.COOKIE);
            if (cookie != null) {
                for (final String part : cookie.split(";")) {
                    final String p = part.trim();
                    if (p.equals("ft=" + app.token())) {
                        return true;
                    }
                }
            }
            return false;
        }

        private void serveImage(final ChannelHandlerContext ctx, final FullHttpRequest req, final String spec) {
            // /img/card/<imageKey>: resolved by CardArtService, which may download first. The request
            // is held while it does, up to IMAGE_HOLD_SECONDS; past that the client gets 202 + Retry-After and asks again
            // (joining the same download). 204 means no art: the client keeps its procedural face. Neither is an
            // error status, so the browser console stays quiet about cards that simply have no picture.
            // /img/crop/<imageKey> is the same for the card's art crop alone; its answer also carries the artist
            // (ARTIST_HEADER, percent-encoded UTF-8) for the credit the client draws with it.
            String what = spec;
            if (spec.equals(AVATAR)) {
                final byte[] avatar = NeuralStatus.avatar();
                if (avatar != null) {
                    send(ctx, req, avatar, NeuralStatus.avatarType(avatar), AVATAR_CACHE);
                    return;
                }
                final String card = NeuralStatus.avatarCard();
                if (card == null || app.art().mode() == CardArtService.Mode.OFF) {
                    sendStatus(ctx, HttpResponseStatus.NOT_FOUND, "not found");
                    return;
                }
                what = "crop/" + NeuralStatus.avatarCardKey(card); // the card's art crop, from here on like any other
            }
            final boolean crop = what.startsWith("crop/");
            if (!crop && !what.startsWith("card/")) {
                sendStatus(ctx, HttpResponseStatus.NOT_FOUND, "not found");
                return;
            }
            final boolean head = req.method() == HttpMethod.HEAD;
            final boolean keepAlive = HttpUtil.isKeepAlive(req);
            final CardArtService art = app.art();
            final String imageKey = what.substring(crop ? "crop/".length() : "card/".length());
            (crop ? art.lookupCrop(imageKey) : art.lookup(imageKey)).copy()
                    .completeOnTimeout(null, IMAGE_HOLD_SECONDS, TimeUnit.SECONDS)
                    .whenComplete((r, e) -> ctx.executor().execute(() -> {
                        if (!ctx.channel().isActive()) {
                            return;
                        }
                        if (r == null) {
                            sendEmpty(ctx, HttpResponseStatus.ACCEPTED, art.indexBuilding() ? 5 : 2, keepAlive);
                            return;
                        }
                        if (r.status() == 503) {
                            sendEmpty(ctx, HttpResponseStatus.ACCEPTED, 10, keepAlive); // failed for now: ask again
                            return;
                        }
                        if (r.status() != 200) {
                            sendEmpty(ctx, HttpResponseStatus.NO_CONTENT, 0, keepAlive);
                            return;
                        }
                        try {
                            final byte[] body = Files.readAllBytes(r.file().toPath());
                            send(ctx, head, keepAlive, body, imageMime(body, r.file().getName()), "private, max-age=86400", r.artist());
                        } catch (final IOException ex) {
                            sendEmpty(ctx, HttpResponseStatus.NO_CONTENT, 0, keepAlive);
                        }
                    }));
        }
    }

    /** A bodiless image answer: 204 (no art) or 202 + Retry-After (still downloading). Never cached. */
    private static void sendEmpty(final ChannelHandlerContext ctx, final HttpResponseStatus status, final int retryAfter, final boolean keepAlive) {
        final FullHttpResponse res = new DefaultFullHttpResponse(HttpVersion.HTTP_1_1, status, Unpooled.EMPTY_BUFFER);
        if (retryAfter > 0) {
            res.headers().set(HttpHeaderNames.RETRY_AFTER, retryAfter);
        }
        res.headers().set(HttpHeaderNames.CACHE_CONTROL, "no-store");
        if (status != HttpResponseStatus.NO_CONTENT) {
            res.headers().set(HttpHeaderNames.CONTENT_LENGTH, 0);
        }
        finish(ctx, res, keepAlive);
    }

    /** Images are typed by their bytes: a cached file's extension isn't proof of its format. */
    public static String imageMime(final byte[] b, final String name) {
        if (b.length > 3 && (b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') {
            return "image/png";
        }
        if (b.length > 2 && (b[0] & 0xff) == 0xff && (b[1] & 0xff) == 0xd8) {
            return "image/jpeg";
        }
        return mime(name);
    }

    /** A file of the web bundle: from {@code webDir}, or the classpath bundle when it is null. Null when missing. */
    public static byte[] readWeb(final File webDir, final String rel) throws IOException {
        if (webDir != null) {
            final File f = new File(webDir, rel);
            return f.isFile() ? Files.readAllBytes(f.toPath()) : null;
        }
        try (InputStream in = BridgeServer.class.getClassLoader().getResourceAsStream("META-INF/forge-table/web/" + rel)) {
            return in == null ? null : in.readAllBytes();
        }
    }

    public static String mime(final String name) {
        final int dot = name.lastIndexOf('.');
        final String ext = dot < 0 ? "" : name.substring(dot + 1).toLowerCase();
        return MIME.getOrDefault(ext, "application/octet-stream");
    }

    private static void send(final ChannelHandlerContext ctx, final FullHttpRequest req, final byte[] body, final String type, final String cache) {
        send(ctx, req.method() == HttpMethod.HEAD, HttpUtil.isKeepAlive(req), body, type, cache);
    }

    private static void send(final ChannelHandlerContext ctx, final boolean head, final boolean keepAlive, final byte[] body,
            final String type, final String cache) {
        send(ctx, head, keepAlive, body, type, cache, null);
    }

    /** @param artist the credit for an art crop, sent as {@link #ARTIST_HEADER}; null for none */
    private static void send(final ChannelHandlerContext ctx, final boolean head, final boolean keepAlive, final byte[] body,
            final String type, final String cache, final String artist) {
        final ByteBuf buf = head ? Unpooled.EMPTY_BUFFER : Unpooled.wrappedBuffer(body);
        final FullHttpResponse res = new DefaultFullHttpResponse(HttpVersion.HTTP_1_1, HttpResponseStatus.OK, buf);
        res.headers().set(HttpHeaderNames.CONTENT_TYPE, type);
        res.headers().set(HttpHeaderNames.CONTENT_LENGTH, body.length);
        res.headers().set(HttpHeaderNames.CACHE_CONTROL, cache);
        res.headers().set("X-Content-Type-Options", "nosniff");
        if (artist != null) {
            // Names are not ASCII (Noriyuki, Jérôme…) and header values must be.
            res.headers().set(ARTIST_HEADER, URLEncoder.encode(artist, StandardCharsets.UTF_8).replace("+", "%20"));
        }
        finish(ctx, res, keepAlive);
    }

    private static void finish(final ChannelHandlerContext ctx, final FullHttpResponse res, final boolean keepAlive) {
        if (keepAlive) {
            res.headers().set(HttpHeaderNames.CONNECTION, HttpHeaderValues.KEEP_ALIVE);
            ctx.writeAndFlush(res);
        } else {
            ctx.writeAndFlush(res).addListener(ChannelFutureListener.CLOSE);
        }
    }

    private static void sendStatus(final ChannelHandlerContext ctx, final HttpResponseStatus status, final String text) {
        final byte[] body = text.getBytes(StandardCharsets.UTF_8);
        final FullHttpResponse res = new DefaultFullHttpResponse(HttpVersion.HTTP_1_1, status, Unpooled.wrappedBuffer(body));
        res.headers().set(HttpHeaderNames.CONTENT_TYPE, "text/plain; charset=utf-8");
        res.headers().set(HttpHeaderNames.CONTENT_LENGTH, body.length);
        // say so, or a keep-alive client reuses the socket we're closing ("header parser received no bytes")
        res.headers().set(HttpHeaderNames.CONNECTION, HttpHeaderValues.CLOSE);
        ctx.writeAndFlush(res).addListener(ChannelFutureListener.CLOSE);
    }
}
