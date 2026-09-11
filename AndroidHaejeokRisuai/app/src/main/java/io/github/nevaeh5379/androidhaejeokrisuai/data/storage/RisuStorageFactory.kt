package io.github.nevaeh5379.androidhaejeokrisuai.data.storage

import android.content.Context
import io.github.nevaeh5379.androidhaejeokrisuai.data.StorageConfig
import io.github.nevaeh5379.androidhaejeokrisuai.data.StorageMode
import io.github.nevaeh5379.androidhaejeokrisuai.data.storage.local.LocalRisuStorage
import io.github.nevaeh5379.androidhaejeokrisuai.data.storage.remote.RemoteRisuStorage

object RisuStorageFactory {
    fun create(context: Context, config: StorageConfig): RisuStorage = when (config.mode) {
        StorageMode.LOCAL_SQLITE -> LocalRisuStorage(context)
        StorageMode.REMOTE_SERVER -> RemoteRisuStorage(config.baseUrl, config.authToken)
    }
}
