package com.ntk.studiowave;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;

import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

@CapacitorPlugin(
    name = "StudioWaveNative",
    permissions = {
        @Permission(
            alias = "storage",
            strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }
        )
    }
)
public class StudioWavePlugin extends Plugin {

    private static String sanitizeFilename(String raw) {
        if (raw == null || raw.trim().isEmpty()) {
            return "NTK-StudioWave-Audio.wav";
        }
        String base = new File(raw.trim()).getName();
        String cleaned = base.replaceAll("[<>:\"/\\\\|?*\\x00-\\x1f]", "_").replaceFirst("^\\.+", "");
        if (cleaned.isEmpty()) {
            return "NTK-StudioWave-Audio.wav";
        }
        return cleaned.length() > 140 ? cleaned.substring(0, 140) : cleaned;
    }

    @PluginMethod
    public void saveFile(PluginCall call) {
        String rawFilename = call.getString("filename", "NTK-StudioWave-Audio.wav");
        String mimeType = call.getString("mimeType", "application/octet-stream");
        String base64Data = call.getString("base64Data");
        if (base64Data == null || base64Data.isEmpty()) {
            call.reject("Missing base64Data");
            return;
        }

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            if (getPermissionState("storage") != PermissionState.GRANTED &&
                ContextCompat.checkSelfPermission(getContext(), Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    != PackageManager.PERMISSION_GRANTED) {
                requestPermissionForAlias("storage", call, "handleStoragePermission");
                return;
            }
        }

        writeFileToDownloads(call, sanitizeFilename(rawFilename), mimeType, base64Data);
    }

    @PermissionCallback
    private void handleStoragePermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q &&
            ContextCompat.checkSelfPermission(getContext(), Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
            call.reject("Storage permission is required to save files to Downloads on Android 8-9.");
            return;
        }
        String rawFilename = call.getString("filename", "NTK-StudioWave-Audio.wav");
        String mimeType = call.getString("mimeType", "application/octet-stream");
        String base64Data = call.getString("base64Data");
        if (base64Data == null || base64Data.isEmpty()) {
            call.reject("Missing base64Data");
            return;
        }
        writeFileToDownloads(call, sanitizeFilename(rawFilename), mimeType, base64Data);
    }

    private void writeFileToDownloads(PluginCall call, String filename, String mimeType, String base64Data) {
        try {
            byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentResolver resolver = getContext().getContentResolver();
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, filename);
                values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/NTK-StudioWave");
                values.put(MediaStore.Downloads.IS_PENDING, 1);

                Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) {
                    call.reject("Could not create file in Downloads.");
                    return;
                }
                try (OutputStream out = resolver.openOutputStream(uri)) {
                    if (out == null) {
                        call.reject("Could not open output stream.");
                        return;
                    }
                    out.write(bytes);
                    out.flush();
                }
                ContentValues doneValues = new ContentValues();
                doneValues.put(MediaStore.Downloads.IS_PENDING, 0);
                resolver.update(uri, doneValues, null, null);
            } else {
                File downloadsRoot = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                File appDir = new File(downloadsRoot, "NTK-StudioWave");
                if (!appDir.exists() && !appDir.mkdirs()) {
                    call.reject("Could not create Downloads/NTK-StudioWave folder.");
                    return;
                }
                File target = resolveUniqueFile(appDir, filename);
                try (FileOutputStream fos = new FileOutputStream(target)) {
                    fos.write(bytes);
                    fos.flush();
                }
                filename = target.getName();
                MediaScannerConnection.scanFile(
                    getContext(),
                    new String[]{target.getAbsolutePath()},
                    new String[]{mimeType},
                    null
                );
            }

            JSObject ret = new JSObject();
            ret.put("saved", true);
            ret.put("location", "Downloads/NTK-StudioWave/" + filename);
            call.resolve(ret);
        } catch (Exception ex) {
            call.reject("Failed to save file: " + ex.getMessage(), ex);
        }
    }

    private static File resolveUniqueFile(File dir, String filename) {
        File candidate = new File(dir, filename);
        if (!candidate.exists()) return candidate;
        int dot = filename.lastIndexOf('.');
        String stem = dot > 0 ? filename.substring(0, dot) : filename;
        String ext = dot > 0 ? filename.substring(dot) : "";
        int i = 1;
        while (candidate.exists()) {
            candidate = new File(dir, stem + "_" + i + ext);
            i++;
        }
        return candidate;
    }

    @PluginMethod
    public void shareFile(PluginCall call) {
        String filename = sanitizeFilename(call.getString("filename", "NTK-StudioWave-Audio.wav"));
        String mimeType = call.getString("mimeType", "audio/*");
        String base64Data = call.getString("base64Data");
        String title = call.getString("title", "NTK StudioWave Audio");
        if (base64Data == null || base64Data.isEmpty()) {
            call.reject("Missing base64Data");
            return;
        }

        try {
            byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);
            File sharedDir = new File(getContext().getCacheDir(), "shared");
            if (!sharedDir.exists()) sharedDir.mkdirs();
            File tempFile = new File(sharedDir, filename);
            try (FileOutputStream fos = new FileOutputStream(tempFile)) {
                fos.write(bytes);
                fos.flush();
            }

            Uri contentUri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                tempFile
            );

            Intent shareIntent = new Intent(Intent.ACTION_SEND);
            shareIntent.setType(mimeType);
            shareIntent.putExtra(Intent.EXTRA_STREAM, contentUri);
            shareIntent.putExtra(Intent.EXTRA_SUBJECT, title);
            shareIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            Intent chooser = Intent.createChooser(shareIntent, title);
            getActivity().runOnUiThread(() -> getActivity().startActivity(chooser));

            JSObject ret = new JSObject();
            ret.put("shared", true);
            call.resolve(ret);
        } catch (Exception ex) {
            call.reject("Failed to share file: " + ex.getMessage(), ex);
        }
    }

    @PluginMethod
    public void setSystemBarTheme(PluginCall call) {
        boolean isDark = Boolean.TRUE.equals(call.getBoolean("isDark", false));
        String bgHex = call.getString("backgroundColor", isDark ? "#0B0E14" : "#F7F8FA");
        Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        activity.runOnUiThread(() -> {
            try {
                Window window = activity.getWindow();
                int bgColor = Color.parseColor(bgHex);
                window.setStatusBarColor(bgColor);
                window.setNavigationBarColor(bgColor);
                View decor = window.getDecorView();
                WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, decor);
                if (controller != null) {
                    controller.setAppearanceLightStatusBars(!isDark);
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        controller.setAppearanceLightNavigationBars(!isDark);
                    }
                }
            } catch (Exception ignored) {
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void setKeepScreenOn(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        activity.runOnUiThread(() -> {
            Window window = activity.getWindow();
            if (enabled) {
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            } else {
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void exitApp(PluginCall call) {
        Activity activity = getActivity();
        if (activity != null) {
            activity.runOnUiThread(activity::finish);
        }
        call.resolve();
    }
}
