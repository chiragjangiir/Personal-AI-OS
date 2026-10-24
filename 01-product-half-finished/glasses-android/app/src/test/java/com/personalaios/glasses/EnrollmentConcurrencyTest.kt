package com.personalaios.glasses

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

class EnrollmentConcurrencyTest {
    @Test fun twoInstancesCompareCompletePairingAndFailedCompareNeverRestoresOrWrites() {
        val disk = PreferenceDisk(); val a = Enrollment(disk.preferences, PlainTestCipher); val b = Enrollment(disk.preferences, PlainTestCipher)
        a.seed(pair()); val expected = a.pairing()!!
        b.seed(JSONObject(expected.toString()).put("governance", JSONObject().put("purpose", "new-consent")))
        val commits = disk.pairingCommits
        disk.failPairingCommit = true
        assertFalse(a.saveOrigin(expected, provenPair()))
        assertEquals(commits, disk.pairingCommits)
        assertTrue(disk.failPairingCommit)
        assertEquals("new-consent", a.pairing()!!.getJSONObject("governance").getString("purpose"))
        assertEquals(canonicalJson(a.pairing()), canonicalJson(Enrollment(disk.restart().preferences, PlainTestCipher).pairing()))
    }

    @Test fun failedCommitRestoresOwnCacheBeforeOtherInstanceCanImport() {
        val disk = PreferenceDisk(); val a = Enrollment(disk.preferences, PlainTestCipher); val b = Enrollment(disk.preferences, PlainTestCipher)
        a.seed(pair()); val expected = a.pairing()!!
        val entered = CountDownLatch(1); val release = CountDownLatch(1); val imported = CountDownLatch(1)
        disk.failPairingCommit = true
        disk.beforePairingCommit = {
            if (disk.failPairingCommit) { entered.countDown(); check(release.await(3, TimeUnit.SECONDS)) }
        }
        var saved: Boolean? = null; var failure: Throwable? = null
        val migration = thread { try { saved = a.saveOrigin(expected, provenPair()) } catch (e: Throwable) { failure = e } }
        assertTrue(entered.await(3, TimeUnit.SECONDS))
        val importer = thread { try { b.seed(pair(device = "replacement")); imported.countDown() } catch (e: Throwable) { failure = e } }
        assertFalse(imported.await(100, TimeUnit.MILLISECONDS))
        release.countDown(); migration.join(3000); importer.join(3000)
        assertFalse(migration.isAlive); assertFalse(importer.isAlive); assertNull(failure); assertEquals(false, saved)
        assertEquals("replacement", a.pairing()!!.getString("device_id"))
        assertEquals("replacement", Enrollment(disk.restart().preferences, PlainTestCipher).pairing()!!.getString("device_id"))
    }

    @Test fun clearAndMigrationShareOneLockAcrossInstances() {
        val disk = PreferenceDisk(); val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val cipher = object : EnrollmentCipher by PlainTestCipher {
            override fun seal(name: String, value: ByteArray): String {
                if (name == "pairing" && JSONObject(value.toString(Charsets.UTF_8)).getString("origin") == DEFAULT_GATEWAY) {
                    entered.countDown(); check(release.await(3, TimeUnit.SECONDS))
                }
                return PlainTestCipher.seal(name, value)
            }
        }
        val a = Enrollment(disk.preferences, cipher); val b = Enrollment(disk.preferences, PlainTestCipher)
        a.seed(pair()); val expected = a.pairing()!!; val cleared = CountDownLatch(1)
        val migration = thread { a.saveOrigin(expected, provenPair()) }
        assertTrue(entered.await(3, TimeUnit.SECONDS))
        val clearer = thread { b.clearPairing(); cleared.countDown() }
        assertFalse(cleared.await(100, TimeUnit.MILLISECONDS)); release.countDown()
        migration.join(3000); clearer.join(3000)
        assertFalse(migration.isAlive); assertFalse(clearer.isAlive)
        assertNull(a.pairing()); assertNull(Enrollment(disk.restart().preferences, PlainTestCipher).pairing())
    }

    @Test fun failedCommitWithoutOtherWriterLeavesCurrentPairingOnCacheAndRestart() {
        val disk = PreferenceDisk(); val a = Enrollment(disk.preferences, PlainTestCipher); val b = Enrollment(disk.preferences, PlainTestCipher)
        a.seed(pair()); val expected = a.pairing()!!; disk.failPairingCommit = true
        assertFalse(b.saveOrigin(expected, provenPair()))
        assertEquals(canonicalJson(expected), canonicalJson(a.pairing()))
        assertEquals(canonicalJson(expected), canonicalJson(Enrollment(disk.restart().preferences, PlainTestCipher).pairing()))
    }
}
