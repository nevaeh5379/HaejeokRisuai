package io.github.nevaeh5379.androidhaejeokrisuai

import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettings
import io.github.nevaeh5379.androidhaejeokrisuai.data.GenerationSettingsMapper
import io.github.nevaeh5379.androidhaejeokrisuai.data.effectivePersonaPrompt
import io.github.nevaeh5379.androidhaejeokrisuai.data.forModelMode
import io.github.nevaeh5379.androidhaejeokrisuai.data.personaProfileToValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GenerationSettingsMapperTest {
    @Test
    fun activePresetOverlaysPromptTemplateAndContextSettings() {
        val base = GenerationSettings(aiModel = "root", maxContext = 4000)
        val preset = mapOf<String, Any?>(
            "aiModel" to "gpt-5",
            "maxContext" to 32768,
            "promptSettings" to mapOf("sendChatAsSystem" to true, "trimStartNewChat" to true),
            "presetRegex" to listOf(mapOf("in" to "foo", "out" to "bar", "type" to "editprocess")),
            "promptTemplate" to listOf(
                mapOf(
                    "type" to "chat",
                    "rangeStart" to -4,
                    "rangeEnd" to "end",
                    "chatAsOriginalOnSystem" to false,
                ),
            ),
        )
        val result = GenerationSettingsMapper.applyPreset(base, preset)
        assertEquals("gpt-5", result.aiModel)
        assertEquals(32768, result.maxContext)
        assertTrue(result.promptSettings.sendChatAsSystem)
        assertTrue(result.promptSettings.trimStartNewChat)
        assertEquals(-4, result.promptTemplate!!.single().rangeStart)
        assertEquals(null, result.promptTemplate!!.single().rangeEnd)
        assertFalse(result.promptTemplate!!.single().chatAsOriginalOnSystem)
        assertEquals("foo", result.presetRegex.single().input)
        assertEquals("bar", result.presetRegex.single().output)
    }

    @Test
    fun auxiliaryModelSettingsSelectOtherAxAndPreserveRawParameters() {
        val result = GenerationSettingsMapper.fromMap(
            mapOf(
                "aiModel" to "gpt-main",
                "subModel" to "gpt-sub",
                "seperateModelsForAxModels" to true,
                "seperateModels" to mapOf("otherAx" to "gpt-ax", "vendorMode" to "vendor-model"),
                "seperateParametersEnabled" to true,
                "seperateParameters" to mapOf(
                    "otherAx" to mapOf(
                        "temperature" to 35,
                        "top_p" to 0.42,
                        "top_k" to 17,
                        "vendor" to mapOf("keep" to true),
                    ),
                ),
            ),
        )
        val ax = result.forModelMode("otherAx")
        assertEquals("gpt-ax", ax.aiModel)
        assertEquals(0.35, ax.temperature, 0.0001)
        assertTrue(ax.temperatureEnabled)
        assertEquals(0.42, ax.topP!!, 0.0001)
        assertEquals("vendor-model", result.seperateModels["vendorMode"])
        val raw = result.seperateParameters["otherAx"] as Map<*, *>
        assertEquals(17, (raw["top_k"] as Number).toInt())
        assertEquals(mapOf("keep" to true), raw["vendor"])
    }

    @Test
    fun auxiliaryModelFallsBackToSubModelAndByModelMinusThousandOmitsSampling() {
        val fallback = GenerationSettings(
            aiModel = "gpt-main",
            subModel = "gpt-sub",
            seperateModelsForAxModels = false,
            seperateModels = mapOf("otherAx" to "ignored"),
        ).forModelMode("otherAx")
        assertEquals("gpt-sub", fallback.aiModel)

        val byModel = GenerationSettings(
            aiModel = "gpt-main",
            subModel = "gpt-sub",
            seperateModelsForAxModels = true,
            seperateModels = mapOf("otherAx" to "gpt-ax"),
            seperateParametersEnabled = true,
            seperateParametersByModel = true,
            seperateParameters = mapOf(
                "overrides" to mapOf(
                    "gpt-ax" to mapOf("temperature" to -1000, "top_p" to -1000, "top_k" to 55),
                ),
            ),
            temperature = 0.9,
            topP = 0.8,
        ).forModelMode("otherAx")
        assertEquals("gpt-ax", byModel.aiModel)
        assertFalse(byModel.temperatureEnabled)
        assertEquals(null, byModel.topP)
    }

    @Test
    fun minusThousandRootTemperatureIsRepresentedAsOmitted() {
        val result = GenerationSettingsMapper.fromMap(mapOf("temperature" to -1000, "top_p" to -1000))
        assertFalse(result.temperatureEnabled)
        assertEquals(null, result.topP)
    }

    @Test
    fun personaSettingsDecodeSelectedFallbackAndPreserveUnknownFields() {
        val result = GenerationSettingsMapper.fromMap(
            mapOf(
                "personaPrompt" to "",
                "selectedPersona" to 1,
                "personas" to listOf(
                    mapOf("name" to "First", "personaPrompt" to "first"),
                    mapOf(
                        "name" to "Second", "personaPrompt" to "second", "id" to "p2",
                        "embeddedModule" to mapOf("vendor" to "keep-me"),
                    ),
                ),
            ),
        )
        assertEquals(1, result.selectedPersona)
        assertEquals("second", result.effectivePersonaPrompt())
        assertEquals("p2", result.personas[1].id)
        val encoded = personaProfileToValue(result.personas[1].copy(personaPrompt = "edited"))
        assertEquals("edited", encoded["personaPrompt"])
        assertEquals(mapOf("vendor" to "keep-me"), encoded["embeddedModule"])
    }
}
