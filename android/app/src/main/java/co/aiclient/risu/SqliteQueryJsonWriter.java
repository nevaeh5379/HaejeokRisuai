package co.aiclient.risu;

import java.io.IOException;
import java.io.Writer;

/** Writes one row at a time; neither rows nor oversized cells are collected. */
final class SqliteQueryJsonWriter {
    private final Writer output;
    private boolean firstColumn;
    private boolean firstByte;

    SqliteQueryJsonWriter(Writer output) {
        this.output = output;
    }

    void beginRow(int queryIndex) throws IOException {
        output.write("{\"type\":\"row\",\"queryIndex\":" + queryIndex + ",\"row\":{");
        firstColumn = true;
    }

    void column(String name) throws IOException {
        if (!firstColumn) output.write(',');
        firstColumn = false;
        string(name);
        output.write(':');
    }

    void endRow() throws IOException {
        output.write("}}\n");
    }

    void endQuery(int queryIndex) throws IOException {
        output.write("{\"type\":\"end\",\"queryIndex\":" + queryIndex + "}\n");
        output.flush();
    }

    void scalar(Object value) throws IOException {
        if (value == null) output.write("null");
        else if (value instanceof Number) {
            double number = ((Number) value).doubleValue();
            if (Double.isNaN(number) || Double.isInfinite(number)) {
                throw new IOException("Non-finite SQLite number");
            }
            output.write(value.toString());
        } else string(value.toString());
    }

    void string(String value) throws IOException {
        beginString();
        stringChunk(value);
        endString();
    }

    void beginString() throws IOException { output.write('"'); }
    void endString() throws IOException { output.write('"'); }

    void stringChunk(String value) throws IOException {
        int start = 0;
        for (int index = 0; index < value.length(); index++) {
            char c = value.charAt(index);
            if (c != '"' && c != '\\' && c >= 0x20 && !Character.isSurrogate(c)) continue;
            output.write(value, start, index - start);
            if (c == '"' || c == '\\') {
                output.write('\\');
                output.write(c);
            } else {
                // Escaping every surrogate preserves both split pairs and lone surrogates.
                output.write("\\u");
                for (int shift = 12; shift >= 0; shift -= 4) {
                    output.write("0123456789abcdef".charAt((c >> shift) & 15));
                }
            }
            start = index + 1;
        }
        output.write(value, start, value.length() - start);
    }

    void beginBlob() throws IOException {
        output.write('[');
        firstByte = true;
    }

    void blobChunk(byte[] bytes) throws IOException {
        for (byte value : bytes) {
            if (!firstByte) output.write(',');
            firstByte = false;
            output.write(Integer.toString(value & 255));
        }
    }

    void endBlob() throws IOException { output.write(']'); }
}
