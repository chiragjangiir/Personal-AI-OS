package com.personalaios.glasses

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

class LauncherContractTest {
    // RayNeo's launcher (ContainerConfig.is2DApp) runs every app without this flag inside its 2D app VM.
    @Test fun launchesAsNativeRayNeoApp() {
        val manifest = File("src/main/AndroidManifest.xml").readText()
        assertTrue(Regex("""<meta-data\s+android:name="com\.rayneo\.mercury\.app"\s+android:value="true"""").containsMatchIn(manifest))
    }
}
