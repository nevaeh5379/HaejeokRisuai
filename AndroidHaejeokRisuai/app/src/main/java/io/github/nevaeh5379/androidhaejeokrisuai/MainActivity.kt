package io.github.nevaeh5379.androidhaejeokrisuai

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import io.github.nevaeh5379.androidhaejeokrisuai.ui.NativeRisuApp
import io.github.nevaeh5379.androidhaejeokrisuai.ui.theme.AndroidHaejeokRisuaiTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            AndroidHaejeokRisuaiTheme {
                NativeRisuApp(applicationContext)
            }
        }
    }
}
