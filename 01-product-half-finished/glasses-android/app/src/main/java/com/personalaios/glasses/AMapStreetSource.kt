package com.personalaios.glasses

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import com.amap.api.maps.*
import com.amap.api.maps.model.*

/** One attached renderer. Official screenshot API includes the SDK logo; TextureView.getBitmap does not.
 * https://lbs.amap.com/api/android-sdk/guide/interaction-with-map/map-screenshot
 * Privacy flags represent actual app disclosure/consent, never the mere presence of an API key.
 */
internal class AMapStreetSource(context: Context, privacyShown: Boolean, privacyAgreed: Boolean) {
    val view: TextureMapView
    private val map: AMap
    private val handler = Handler(Looper.getMainLooper())
    private var loaded = false
    private var generation = 0
    private var polyline: Polyline? = null
    private var route = emptyList<NavCoordinate>()
    init {
        MapsInitializer.updatePrivacyShow(context, true, privacyShown)
        MapsInitializer.updatePrivacyAgree(context, privacyAgreed)
        view = TextureMapView(context)
        view.onCreate(Bundle())
        map = view.map
        map.mapType = AMap.MAP_TYPE_NIGHT
        map.setRenderFps(10)
        map.isMyLocationEnabled = false
        map.showBuildings(false)
        map.uiSettings.apply {
            setAllGesturesEnabled(false)
            isZoomControlsEnabled = false; isCompassEnabled = false
            isScaleControlsEnabled = false; isMyLocationButtonEnabled = false
            isIndoorSwitchEnabled = false
            logoPosition = AMapOptions.LOGO_POSITION_BOTTOM_CENTER
            setLogoBottomMargin(108) // Reserve the upper interior for the full-size logo, clear of the user arrow.
        }
        map.setOnMapLoadedListener { loaded = true }
    }
    fun resume() = view.onResume()
    fun pause() { generation++; view.onPause() }
    fun destroy() { generation++; view.onDestroy(); handler.removeCallbacksAndMessages(null) }

    /** At most one request in flight, owned by NavigationMirror. Never move the camera during a capture. */
    fun capture(state: MiniMapState, done: (Bitmap?, String?, String?, Double) -> Unit): Boolean {
        if (!loaded || view.width == 0) return false
        if (route != state.route) {
            route = state.route
            polyline?.remove()
            polyline = if (route.size < 2) null else map.addPolyline(PolylineOptions()
                .addAll(NavPolyline.simplify(route).map { LatLng(it.latitude, it.longitude) })
                .width(5f).zIndex(10f).color(Color.rgb(63, 203, 132)))
        }
        map.setPointToCenter(view.width/2, view.height/2 + 20)
        val camera = CameraPosition(LatLng(state.position.latitude, state.position.longitude), 17f, 0f, state.headingDegrees.toFloat())
        map.moveCamera(CameraUpdateFactory.newCameraPosition(camera))
        val current = generation
        map.getMapScreenShot(object : AMap.OnMapScreenShotListener {
            override fun onMapScreenShot(bitmap: Bitmap?) = Unit
            override fun onMapScreenShot(bitmap: Bitmap?, status: Int) {
                if (current != generation) return
                done(bitmap.takeIf { status != 0 }, map.mapContentApprovalNumber,
                    if (bitmap == null || status == 0) "高德街道图暂不可用" else null, map.scalePerPixel.toDouble())
            }
        }, handler)
        return true
    }
}
