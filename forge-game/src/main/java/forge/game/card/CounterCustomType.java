package forge.game.card;

import java.util.Map;
import java.util.Set;
import java.util.LinkedHashSet;


public record CounterCustomType(String keyword) implements CounterType {
    // forge-table: lazily filled from game threads; concurrent so N games per JVM cannot corrupt it
    private static final Map<String, CounterCustomType> sMap = new java.util.concurrent.ConcurrentHashMap<>();

    public static CounterCustomType get(String s) {
        return sMap.computeIfAbsent(s, k -> new CounterCustomType(k));
    }

    public static Set<CounterType> getValues() {
        return new LinkedHashSet<CounterType>(sMap.values());
    }
    
    @Override
    public String toString() {
        return keyword;
    }

    public String getName() {
        return keyword;
    }
}
