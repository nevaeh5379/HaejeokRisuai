package co.aiclient.risu;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class AndroidSafeAreaTest {
    @Test
    public void convertsPhysicalInsetsToCssPixels() {
        assertEquals(48, AndroidSafeArea.toCssPixels(144, 3.0f));
        assertEquals(49, AndroidSafeArea.toCssPixels(171, 3.5f));
        assertEquals(0, AndroidSafeArea.toCssPixels(0, 3.0f));
    }

    @Test
    public void preservesPixelsWhenDensityIsInvalid() {
        assertEquals(48, AndroidSafeArea.toCssPixels(48, 0.0f));
    }
}
