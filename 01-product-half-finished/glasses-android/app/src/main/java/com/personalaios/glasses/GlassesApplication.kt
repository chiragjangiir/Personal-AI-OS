package com.personalaios.glasses

import android.app.Application
import android.os.Process
import android.util.Log
import com.ffalcon.mercury.android.sdk.MercurySDK

class GlassesApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        Log.w("Yimi", "process_create pid=${Process.myPid()}")
        MercurySDK.init(this)
    }
}
