package io.github.nevaeh5379.androidhaejeokrisuai.data.storage.local

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import io.github.nevaeh5379.androidhaejeokrisuai.R

internal class RisuSqliteOpenHelper(private val context: Context) :
    SQLiteOpenHelper(context, DATABASE_NAME, null, DATABASE_VERSION) {

    override fun onConfigure(db: SQLiteDatabase) {
        super.onConfigure(db)
        db.setForeignKeyConstraintsEnabled(true)
    }

    override fun onCreate(db: SQLiteDatabase) = applySchema(db)

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        throw IllegalStateException(
            "Unsupported native Risu SQLite schema upgrade: $oldVersion -> $newVersion. " +
                "Export or migrate the database with a compatible RisuAI build first.",
        )
    }

    override fun onOpen(db: SQLiteDatabase) {
        super.onOpen(db)
        db.rawQuery(
            "SELECT schema_version, schema_layout FROM system_storage_meta WHERE singleton = 1",
            null,
        ).use { cursor ->
            if (!cursor.moveToFirst()) error("Risu SQLite metadata is missing")
            val version = cursor.getInt(0)
            val layout = cursor.getString(1)
            require(version == DATABASE_VERSION && layout == SCHEMA_LAYOUT) {
                "Incompatible Risu SQLite schema: version=$version layout=$layout"
            }
        }
    }

    private fun applySchema(db: SQLiteDatabase) {
        val script = context.resources.openRawResource(R.raw.risu_schema)
            .bufferedReader()
            .use { it.readText() }
        val normalized = script.lineSequence()
            .filterNot { it.trimStart().startsWith("--") }
            .filterNot { it.trimStart().startsWith("PRAGMA ", ignoreCase = true) }
            .joinToString("\n")
            // Android vendor SQLite builds (especially older devices) may omit JSON1.
            // plugin_custom_storage still stores JSON text; only the optional DB-level CHECK is removed.
            .replace("value TEXT NOT NULL CHECK (json_valid(value))", "value TEXT NOT NULL")
        normalized.split(';')
            .map(String::trim)
            .filter(String::isNotEmpty)
            .forEach(db::execSQL)
    }

    companion object {
        const val DATABASE_NAME = "risuai-native.sqlite3"
        const val DATABASE_VERSION = 3
        const val SCHEMA_LAYOUT = "relational-schema-v3"
    }
}
