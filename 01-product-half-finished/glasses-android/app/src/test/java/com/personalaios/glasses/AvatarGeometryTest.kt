package com.personalaios.glasses

import org.junit.Assert.assertEquals
import org.junit.Test

class AvatarGeometryTest {
    @Test fun eachEyeUsesTheSameTopLeftReferenceFrame() {
        val leftEye = avatarFrame(640, 480)
        val rightEye = avatarFrame(640, 480)
        assertEquals(AvatarFrame(30, 20, 144, 144), leftEye)
        assertEquals(leftEye, rightEye)
    }

    @Test fun frameTracksActualViewportDimensions() {
        assertEquals(AvatarFrame(60, 40, 288, 288), avatarFrame(1280, 960))
        assertEquals(AvatarFrame(15, 10, 72, 72), avatarFrame(320, 240))
        assertEquals(AvatarFrame(60, 20, 288, 144), avatarFrame(1280, 480))
    }
}
