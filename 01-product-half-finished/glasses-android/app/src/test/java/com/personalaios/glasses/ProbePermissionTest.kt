package com.personalaios.glasses

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.*
import org.junit.Test
import org.w3c.dom.Element

class ProbePermissionTest {
    @Test fun everyExportedDebugProbeRequiresOurSignaturePermission() {
        val document = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
            .newDocumentBuilder().parse(File("src/debug/AndroidManifest.xml"))
        val android = "http://schemas.android.com/apk/res/android"
        fun Element.attribute(name: String) = getAttributeNS(android, name)
        val permissions = document.getElementsByTagName("permission")
        val permission = (0 until permissions.length).map { permissions.item(it) as Element }.single {
            it.attribute("name") == "com.personalaios.glasses.permission.DEBUG_PROBE"
        }
        assertEquals("signature", permission.attribute("protectionLevel"))
        val services = document.getElementsByTagName("service")
        val probe = (0 until services.length).map { services.item(it) as Element }.single {
            it.attribute("name") == ".ProbeService"
        }
        assertEquals("true", probe.attribute("exported"))
        assertEquals(permission.attribute("name"), probe.attribute("permission"))
    }
}
