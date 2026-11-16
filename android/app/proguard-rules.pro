# R8 rules for the release build. Libraries with their own consumer rules (OkHttp, Compose, WorkManager,
# Glance, kotlinx-serialization, coroutines) need nothing here.

# Tink (used directly for X25519 and through androidx.security:security-crypto) reads its shaded
# protobuf-lite messages by field name through reflection. Without this, EncryptedSharedPreferences
# fails at runtime in a minified build.
-keepclassmembers class * extends com.google.crypto.tink.shaded.protobuf.GeneratedMessageLite {
    <fields>;
}

# Compile-only references inside Tink that are not on the Android classpath.
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**
-dontwarn com.google.api.client.**
-dontwarn org.joda.time.**

# Glance stores the widget class name next to each placed widget and looks widgets up by it
# (GlanceAppWidgetManager). A stable name keeps updateAll working across app updates.
-keepnames class dev.gajae.gjcmobile.widget.GjcWidget

# Readable crash traces after retracing with mapping.txt.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
