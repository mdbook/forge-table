package forge.bridge.auth;

import java.io.BufferedReader;
import java.io.Console;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.sql.SQLException;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;

/**
 * {@code forge.bridge.Main --users ...}: manage native sign-in accounts from the shell (the first admin can only come
 * from here, never from an environment variable). Works on the same {@code <data>/forge-table.db} the router uses,
 * found the same way ({@code --data}, {@code FT_DATA}, {@code --config} / {@code FT_CONFIG}), and is safe while the
 * router runs: a turned-off account's sessions end on its next request.
 */
public final class UsersCli {
    static final String USAGE = """
            Usage: forge.bridge.Main --users <command> [--data DIR] [--config FILE]
              add <login> [--admin] [--name NAME]   new account; reads its password from the terminal or stdin
              list                                  every account
              reset <login>                         new password (terminal or stdin); signs them out everywhere
              disable <login> | enable <login>      turn an account off (signed out at once) or back on
              admin <login> on|off                  make an account an admin, or not
              delete <login>                        remove an account (their decks and records stay on disk)
              link <login> <provider> <subject>     let an OIDC sign-in use this account (the log names all three)
              unlink <login> <provider>             undo that
            Logins are lowercase letters, digits, dot, underscore and dash, up to 32 characters.""";

    private final InputStream in;
    private final PrintStream out;
    private final PrintStream err;
    private final Console console;

    UsersCli(final InputStream in, final PrintStream out, final PrintStream err, final Console console) {
        this.in = in;
        this.out = out;
        this.err = err;
        this.console = console;
    }

    /** Runs {@code args} (what follows {@code --users}); returns the exit code. */
    public static int main(final String[] args) {
        final Path dataDir;
        try {
            dataDir = forge.bridge.router.Router.dataDir(args);
        } catch (final IllegalArgumentException e) {
            System.err.println(e.getMessage());
            return 2;
        }
        return new UsersCli(System.in, System.out, System.err, System.console()).run(args, dataDir);
    }

    /** {@code argv} with its {@code --data} and {@code --config} (already resolved into {@code dataDir}) set aside. */
    int run(final String[] argv, final Path dataDir) {
        final List<String> args = new ArrayList<>();
        for (int i = 0; i < argv.length; i++) {
            if ((argv[i].equals("--data") || argv[i].equals("--config")) && i + 1 < argv.length) {
                i++;
            } else {
                args.add(argv[i]);
            }
        }
        final boolean admin = args.remove("--admin");
        String name = null;
        final int n = args.indexOf("--name");
        if (n >= 0) {
            if (n + 1 >= args.size()) {
                return usage("--name needs a value");
            }
            name = args.get(n + 1).trim();
            args.subList(n, n + 2).clear();
        }
        if (args.isEmpty()) {
            return usage(null);
        }
        final String cmd = args.get(0);
        if (cmd.equals("help") || cmd.equals("--help")) {
            out.println(USAGE);
            return 0;
        }
        final int want = switch (cmd) {
            case "list" -> 1;
            case "add", "reset", "disable", "enable", "delete" -> 2;
            case "admin", "unlink" -> 3;
            case "link" -> 4;
            default -> -1;
        };
        if (want < 0) {
            return usage("unknown command " + cmd);
        }
        if (args.size() != want) {
            return usage(cmd + " takes " + (want - 1) + " argument" + (want == 2 ? "" : "s"));
        }
        if ((admin || name != null) && !cmd.equals("add")) {
            return usage("--admin and --name go with add");
        }
        try (UserStore store = new UserStore(dataDir.resolve("forge-table.db"))) {
            if (cmd.equals("list")) {
                return list(store);
            }
            final String login = UserStore.localLogin(args.get(1));
            if (cmd.equals("add")) {
                if (login == null) {
                    return usage("not a valid login: " + args.get(1));
                }
                if (store.user(login) != null) {
                    err.println(login + " already exists");
                    return 1;
                }
                final String pw = readNew();
                if (pw == null) {
                    return 1;
                }
                store.add(login, name == null || name.isEmpty() ? null : name, Pbkdf2Hasher.hash(pw), admin, System.currentTimeMillis());
                out.println("added " + login + (admin ? " (admin)" : ""));
                return 0;
            }
            // exactly as typed first: OIDC logins keep their case; then as a local login
            final UserStore.User exact = store.user(args.get(1));
            final UserStore.User u = exact != null || login == null ? exact : store.user(login);
            if (u == null) {
                err.println("no account " + args.get(1));
                return 1;
            }
            switch (cmd) {
                case "reset" -> {
                    final String pw = readNew();
                    if (pw == null) {
                        return 1;
                    }
                    store.setPasswordHash(u.id(), Pbkdf2Hasher.hash(pw), null);
                    out.println("new password set for " + u.login() + "; signed out everywhere");
                }
                case "disable" -> {
                    store.setDisabled(u.id(), true);
                    out.println(u.login() + " is turned off and signed out");
                }
                case "enable" -> {
                    store.setDisabled(u.id(), false);
                    out.println(u.login() + " is turned on");
                }
                case "admin" -> {
                    final String v = args.get(2);
                    if (!v.equals("on") && !v.equals("off")) {
                        return usage("admin takes on or off");
                    }
                    store.setAdmin(u.id(), v.equals("on"));
                    out.println(u.login() + (v.equals("on") ? " is an admin" : " is not an admin"));
                }
                case "link" -> {
                    final UserStore.User other = store.linked(args.get(2), args.get(3));
                    if (other != null) {
                        err.println("that sign-in is already linked to " + other.login() + " (unlink it there first)");
                        return 1;
                    }
                    store.link(u.id(), args.get(2), args.get(3));
                    out.println(u.login() + " is linked to " + args.get(2));
                }
                case "unlink" -> {
                    if (!store.unlink(u.id(), args.get(2))) {
                        err.println(u.login() + " has no link to " + args.get(2));
                        return 1;
                    }
                    out.println(u.login() + " is no longer linked to " + args.get(2));
                }
                default -> { // delete
                    store.delete(u.id());
                    out.println("deleted " + u.login() + " (their decks and records stay under users/)");
                }
            }
            return 0;
        } catch (final SQLException e) {
            err.println("cannot use " + dataDir.resolve("forge-table.db") + ": " + e.getMessage());
            return 1;
        }
    }

    private int list(final UserStore store) throws SQLException {
        final DateTimeFormatter day = DateTimeFormatter.ofPattern("yyyy-MM-dd").withZone(ZoneId.systemDefault());
        final List<UserStore.User> all = store.users();
        if (all.isEmpty()) {
            out.println("no accounts yet: add one with  --users add <login> --admin");
            return 0;
        }
        for (final UserStore.User u : all) {
            out.println(u.login() + "\t" + (u.admin() ? "admin" : "-") + "\t" + (u.disabled() ? "off" : "on") + "\t"
                    + (u.passwordHash() == null ? "no password" : "password") + "\t"
                    + (u.lastLogin() == 0 ? "never signed in" : "last sign-in " + day.format(Instant.ofEpochMilli(u.lastLogin())))
                    + (u.displayName() == null ? "" : "\t" + u.displayName()));
            for (final UserStore.Link l : store.links(u.id())) {
                out.println("\tlinked to " + l.provider() + " as " + l.subject());
            }
        }
        return 0;
    }

    /** A new password: typed twice at a terminal, else the first line of stdin. Null (after saying why) when unusable. */
    private String readNew() {
        final String pw;
        if (console != null) {
            final char[] a = console.readPassword("New password: ");
            final char[] b = a == null ? null : console.readPassword("Again: ");
            if (a == null || b == null || !new String(a).equals(new String(b))) {
                err.println("the passwords don't match");
                return null;
            }
            pw = new String(a);
        } else {
            try {
                final String line = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8)).readLine();
                pw = line == null ? "" : line;
            } catch (final IOException e) {
                err.println("cannot read the password: " + e.getMessage());
                return null;
            }
        }
        final String problem = Pbkdf2Hasher.problem(pw);
        if (problem != null) {
            err.println(problem);
            return null;
        }
        return pw;
    }

    private int usage(final String problem) {
        if (problem != null) {
            err.println(problem);
        }
        err.println(USAGE);
        return 2;
    }
}
