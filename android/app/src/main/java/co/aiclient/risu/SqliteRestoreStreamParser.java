package co.aiclient.risu;

import com.google.gson.stream.JsonReader;
import com.google.gson.stream.JsonToken;
import java.io.IOException;
import java.io.Reader;
import java.util.ArrayList;
import java.util.List;

final class SqliteRestoreStreamParser {
    interface StatementHandler {
        void execute(String sql, List<Object> bind) throws Exception;
    }

    interface ProgressHandler {
        void onStatement(int completed);
    }

    private SqliteRestoreStreamParser() {}

    static int parse(
        Reader source,
        StatementHandler handler,
        ProgressHandler progress
    ) throws Exception {
        int completed = 0;
        try (JsonReader reader = new JsonReader(source)) {
            reader.beginArray();
            while (reader.hasNext()) {
                parseStatement(reader, handler);
                completed++;
                if (progress != null) progress.onStatement(completed);
            }
            reader.endArray();
        }
        return completed;
    }
    private static void parseStatement(
        JsonReader reader,
        StatementHandler handler
    ) throws Exception {
        String sql = null;
        List<Object> bind = new ArrayList<>();
        reader.beginObject();
        while (reader.hasNext()) {
            String name = reader.nextName();
            if ("sql".equals(name)) {
                sql = reader.nextString();
            } else if ("bind".equals(name)) {
                readBindArray(reader, bind);
            } else {
                reader.skipValue();
            }
        }
        reader.endObject();
        if (sql == null || sql.trim().isEmpty()) {
            throw new IOException("Restore statement is missing SQL");
        }
        handler.execute(sql, bind);
    }

    private static void readBindArray(JsonReader reader, List<Object> bind)
        throws IOException {
        reader.beginArray();
        while (reader.hasNext()) bind.add(readBindValue(reader));
        reader.endArray();
    }
    private static Object readBindValue(JsonReader reader) throws IOException {
        JsonToken token = reader.peek();
        switch (token) {
            case NULL:
                reader.nextNull();
                return null;
            case BOOLEAN:
                return reader.nextBoolean() ? 1L : 0L;
            case STRING:
                return reader.nextString();
            case NUMBER:
                return parseNumber(reader.nextString());
            default:
                throw new IOException("Unsupported SQLite bind token: " + token);
        }
    }

    private static Number parseNumber(String value) throws IOException {
        try {
            if (
                value.indexOf('.') >= 0 ||
                value.indexOf('e') >= 0 ||
                value.indexOf('E') >= 0
            ) {
                return Double.valueOf(value);
            }
            return Long.valueOf(value);
        } catch (NumberFormatException error) {
            throw new IOException("Invalid SQLite numeric bind: " + value, error);
        }
    }
}
