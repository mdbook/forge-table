package forge.bridge.match;

import static org.testng.Assert.assertTrue;

import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.Map;
import java.util.TreeSet;

import org.testng.annotations.Test;

import forge.bridge.BridgeGuiBase;
import forge.gui.interfaces.IGuiBase;
import forge.gui.interfaces.IGuiGame;

/**
 * Every IGuiGame / IGuiBase method has a row in {@link GuiMapping} and a concrete implementation.
 * Fails after an upstream rebase adds a GUI call, so the new call gets a deliberate mapping.
 */
public class IGuiGameContractTest {

    @Test
    public void everyGuiGameMethodIsMapped() {
        check(IGuiGame.class, BridgeGuiGame.class, GuiMapping.GUI_GAME);
    }

    @Test
    public void everyGuiBaseMethodIsMapped() {
        check(IGuiBase.class, BridgeGuiBase.class, GuiMapping.GUI_BASE);
    }

    private static void check(final Class<?> iface, final Class<?> impl, final Map<String, String> mapping) {
        final TreeSet<String> missing = new TreeSet<>();
        final TreeSet<String> abstractLeft = new TreeSet<>();
        for (final Method m : iface.getMethods()) {
            if (Modifier.isStatic(m.getModifiers())) {
                continue;
            }
            if (!mapping.containsKey(m.getName())) {
                missing.add(m.getName());
            }
            try {
                final Method im = impl.getMethod(m.getName(), m.getParameterTypes());
                if (Modifier.isAbstract(im.getModifiers())) {
                    abstractLeft.add(m.getName());
                }
            } catch (final NoSuchMethodException e) {
                abstractLeft.add(m.getName());
            }
        }
        final TreeSet<String> stale = new TreeSet<>(mapping.keySet());
        for (final Method m : iface.getMethods()) {
            stale.remove(m.getName());
        }
        assertTrue(missing.isEmpty(), iface.getSimpleName() + " methods without a GuiMapping row: " + missing);
        assertTrue(abstractLeft.isEmpty(), impl.getSimpleName() + " leaves unimplemented: " + abstractLeft);
        assertTrue(stale.isEmpty(), "GuiMapping rows for methods " + iface.getSimpleName() + " no longer has: " + stale);
    }
}
