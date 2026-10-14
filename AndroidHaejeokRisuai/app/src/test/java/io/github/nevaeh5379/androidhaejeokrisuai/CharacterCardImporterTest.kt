package io.github.nevaeh5379.androidhaejeokrisuai

import io.github.nevaeh5379.androidhaejeokrisuai.importing.CharacterCardImporter
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets

class CharacterCardImporterTest {
    @Test
    fun ccv3MetadataTakesPrecedenceOverLegacyCharaChunk() {
        val png = ByteArrayOutputStream().apply {
            write(byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
            write(chunk("tEXt", "chara\u0000legacy".toByteArray(StandardCharsets.ISO_8859_1)))
            write(chunk("tEXt", "ccv3\u0000new-card".toByteArray(StandardCharsets.ISO_8859_1)))
            write(chunk("IEND", byteArrayOf()))
        }.toByteArray()

        assertEquals("new-card", CharacterCardImporter.extractCardMetadata(png))
    }

    private fun chunk(type: String, data: ByteArray): ByteArray = ByteArrayOutputStream().apply {
        val length = data.size
        write(byteArrayOf(
            (length ushr 24).toByte(),
            (length ushr 16).toByte(),
            (length ushr 8).toByte(),
            length.toByte(),
        ))
        write(type.toByteArray(StandardCharsets.US_ASCII))
        write(data)
        write(byteArrayOf(0, 0, 0, 0)) // CRC is intentionally irrelevant to the metadata reader.
    }.toByteArray()
}
