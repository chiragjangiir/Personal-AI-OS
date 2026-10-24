import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Bitmap;
import android.graphics.Point;
import android.graphics.Rect;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.Xml;
import android.view.Display;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.ByteArrayOutputStream;
import android.util.Base64;
import org.json.JSONObject;
import java.util.List;
import org.xmlpull.v1.XmlSerializer;

/** One errand-scoped capture process. EOF disconnects without changing phone settings. */
public class PhoneObservation {
    public static void main(String[] unused) throws Exception {
        Thread.setDefaultUncaughtExceptionHandler((t, error) -> { error.printStackTrace(System.err); System.exit(1); });
        Looper.prepareMainLooper();  // AccessibilityInteractionClient also uses the main looper on Android 16.
        HandlerThread thread = new HandlerThread("phone-observation"); thread.start();
        try {
            Class<?> connection = Class.forName("android.app.IUiAutomationConnection");
            UiAutomation ui = (UiAutomation) UiAutomation.class.getConstructor(Looper.class, connection)
                .newInstance(thread.getLooper(), Class.forName("android.app.UiAutomationConnection").getConstructor().newInstance());
            try {
                emit(new JSONObject().put("stage", "connect"));
                UiAutomation.class.getMethod("connect", int.class).invoke(ui, UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
                AccessibilityServiceInfo info = ui.getServiceInfo();
                info.flags |= AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS | AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
                ui.setServiceInfo(info);
                emit(new JSONObject().put("kind", "ready").put("pid", android.os.Process.myPid()));
                BufferedReader input = new BufferedReader(new InputStreamReader(System.in, "UTF-8"));
                String line;
                while ((line = input.readLine()) != null) {
                    String[] args = line.split(" ");
                    long start = System.nanoTime();
                    String stage = args[0];
                    try {
                        emit(new JSONObject().put("stage", stage));
                        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                        JSONObject result = new JSONObject().put("kind", args[0]);
                        if (args[0].equals("screen")) {
                            Bitmap image = ui.takeScreenshot();
                            if (image == null) throw new IllegalStateException("takeScreenshot returned null");
                            stage = "encode";
                            emit(new JSONObject().put("stage", stage));
                            result.put("width", image.getWidth()).put("height", image.getHeight());
                            double scale = Math.min(1.0, (double) Integer.parseInt(args[1]) / Math.max(image.getWidth(), image.getHeight()));
                            Bitmap scaled = Bitmap.createScaledBitmap(image, (int) Math.round(image.getWidth() * scale),
                                                                       (int) Math.round(image.getHeight() * scale), true);
                            try {
                                if (!scaled.compress(Bitmap.CompressFormat.JPEG, 75, bytes))
                                    throw new IllegalStateException("image encoder failed");
                            } finally { if (scaled != image) scaled.recycle(); image.recycle(); }
                        } else if (args[0].equals("tree")) {
                            Class<?> manager = Class.forName("android.hardware.display.DisplayManagerGlobal");
                            Object displays = manager.getMethod("getInstance").invoke(null);
                            Display display = (Display) manager.getMethod("getRealDisplay", int.class).invoke(displays, 0);
                            Point size = new Point(); display.getRealSize(size);
                            AccessibilityNodeInfo root = ui.getRootInActiveWindow();
                            if (root == null) throw new IllegalStateException("No active UI root");
                            List<AccessibilityWindowInfo> windows = ui.getWindows();
                            int activeLayer = 0;
                            for (AccessibilityWindowInfo window : windows)
                                if (window.getId() == root.getWindowId()) activeLayer = window.getLayer();
                            XmlSerializer xml = Xml.newSerializer(); xml.setOutput(bytes, "UTF-8");
                            xml.startDocument("UTF-8", true); xml.startTag(null, "hierarchy");
                            xml.attribute(null, "width", Integer.toString(size.x)); xml.attribute(null, "height", Integer.toString(size.y));
                            try {
                                node(xml, root, size);
                                for (int i = windows.size() - 1; i >= 0; i--) {
                                    AccessibilityWindowInfo window = windows.get(i);
                                    if (window.getType() != AccessibilityWindowInfo.TYPE_APPLICATION || window.getLayer() <= activeLayer) continue;
                                    AccessibilityNodeInfo overlay = window.getRoot();
                                    if (overlay != null) try { node(xml, overlay, size); } finally { overlay.recycle(); }
                                }
                            } finally {
                                root.recycle();
                                for (AccessibilityWindowInfo window : windows) window.recycle();
                            }
                            xml.endTag(null, "hierarchy"); xml.endDocument(); xml.flush();
                        } else throw new IllegalArgumentException("screen or tree required");
                        emit(result.put("data", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP))
                                   .put("elapsed_ms", (System.nanoTime() - start) / 1000000));
                    } catch (Exception error) {
                        emit(new JSONObject().put("kind", "error").put("stage", stage).put("detail", error.toString())
                                             .put("elapsed_ms", (System.nanoTime() - start) / 1000000));
                    }
                }
            } finally { UiAutomation.class.getMethod("disconnect").invoke(ui); }
        } finally { thread.quitSafely(); }
    }

    private static void emit(JSONObject data) { System.out.println(data); System.out.flush(); }

    private static void node(XmlSerializer xml, AccessibilityNodeInfo n, Point size) throws Exception {
        xml.startTag(null, "node");
        attr(xml, "text", n.getText()); attr(xml, "resource-id", n.getViewIdResourceName());
        attr(xml, "class", n.getClassName()); attr(xml, "package", n.getPackageName());
        attr(xml, "content-desc", n.getContentDescription()); attr(xml, "hint", n.getHintText());
        attr(xml, "checkable", n.isCheckable()); attr(xml, "checked", n.isChecked());
        attr(xml, "clickable", n.isClickable()); attr(xml, "enabled", n.isEnabled());
        attr(xml, "focusable", n.isFocusable()); attr(xml, "focused", n.isFocused());
        attr(xml, "scrollable", n.isScrollable()); attr(xml, "long-clickable", n.isLongClickable());
        attr(xml, "password", n.isPassword()); attr(xml, "selected", n.isSelected()); attr(xml, "editable", n.isEditable());
        Rect bounds = new Rect(); n.getBoundsInScreen(bounds);
        bounds.intersect(0, 0, size.x, size.y); attr(xml, "bounds", bounds.toShortString());
        for (int i = 0; i < n.getChildCount(); i++) {
            AccessibilityNodeInfo child = n.getChild(i);
            if (child == null) continue;
            try { if (child.isVisibleToUser()) node(xml, child, size); } finally { child.recycle(); }
        }
        xml.endTag(null, "node");
    }

    private static void attr(XmlSerializer xml, String key, Object value) throws Exception {
        xml.attribute(null, key, value == null ? "" : value.toString());
    }
}
