package io.github.nevaeh5379.androidhaejeokrisuai

import io.github.nevaeh5379.androidhaejeokrisuai.data.storage.RelationalNodeCodec
import org.junit.Assert.assertEquals
import org.junit.Test

class RelationalNodeCodecTest {
    @Test
    fun roundTripsNestedRisuValue() {
        val source = linkedMapOf<String, Any?>(
            "role" to "user",
            "data" to "hello",
            "flags" to listOf(true, false, null),
            "nested" to linkedMapOf("temperature" to 0.7),
        )
        assertEquals(source, RelationalNodeCodec.rebuild(RelationalNodeCodec.flatten(source)))
    }

    @Test
    fun roundTripsUnsafeUtf16Text() {
        val source = linkedMapOf<String, Any?>("nul" to "a\u0000b")
        assertEquals(source, RelationalNodeCodec.rebuild(RelationalNodeCodec.flatten(source)))
    }
}
