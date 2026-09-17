package co.aiclient.risu;

final class WidgetGridLayoutPlanner {
    private static final int MAX_COLUMNS = 4;
    private static final float OUTER_PADDING = 12f;
    private static final float COLUMN_PADDING = 6f;
    private static final float CARD_GAP = 6f;
    private static final float MIN_CARD_WIDTH = 82f;

    static final class Plan {
        final int columns;
        final int[] itemColumns;
        final float columnWidth;
        final float maxHeight;
        final float score;

        Plan(int columns, int[] itemColumns, float columnWidth, float maxHeight, float score) {
            this.columns = columns;
            this.itemColumns = itemColumns;
            this.columnWidth = columnWidth;
            this.maxHeight = maxHeight;
            this.score = score;
        }
    }

    private WidgetGridLayoutPlanner() {}
    static Plan choose(int width, int height, float[] aspectRatios) {
        int count = aspectRatios.length;
        if (count == 0) return new Plan(1, new int[0], 48f, 0f, 0f);

        float availableWidth = Math.max(48f, width - OUTER_PADDING);
        float availableHeight = Math.max(48f, height - OUTER_PADDING);
        int maxByWidth = Math.max(
            1,
            Math.min(MAX_COLUMNS, (int) ((availableWidth + COLUMN_PADDING) / (MIN_CARD_WIDTH + COLUMN_PADDING)))
        );
        int maxColumns = Math.min(count, maxByWidth);
        Plan best = null;

        for (int columns = 1; columns <= maxColumns; columns++) {
            float columnWidth = Math.max(48f, (availableWidth / columns) - COLUMN_PADDING);
            float[] heights = new float[columns];
            int[] assignments = new int[count];

            for (int item = 0; item < count; item++) {
                int targetColumn = shortestColumn(heights);
                assignments[item] = targetColumn;
                if (heights[targetColumn] > 0f) heights[targetColumn] += CARD_GAP;
                heights[targetColumn] += columnWidth * sanitizeRatio(aspectRatios[item]);
            }
            float maxHeight = 0f;
            float minHeight = Float.MAX_VALUE;
            for (float columnHeight : heights) {
                maxHeight = Math.max(maxHeight, columnHeight);
                minHeight = Math.min(minHeight, columnHeight);
            }
            float overflow = Math.max(0f, maxHeight - availableHeight);
            float unused = Math.max(0f, availableHeight - maxHeight);
            float imbalance = Math.max(0f, maxHeight - minHeight);
            boolean fits = overflow <= availableHeight * 0.04f;
            float score = fits
                ? unused / availableHeight + (imbalance / availableHeight) * 0.15f + columns * 0.025f
                : 10f + (overflow / availableHeight) * 8f + (imbalance / availableHeight) * 0.2f;

            Plan candidate = new Plan(columns, assignments, columnWidth, maxHeight, score);
            if (best == null || candidate.score < best.score) best = candidate;
        }
        return best;
    }

    private static int shortestColumn(float[] heights) {
        int best = 0;
        for (int index = 1; index < heights.length; index++) {
            if (heights[index] < heights[best]) best = index;
        }
        return best;
    }

    private static float sanitizeRatio(float ratio) {
        if (!Float.isFinite(ratio) || ratio <= 0f) return 1f;
        return Math.max(0.35f, Math.min(3.2f, ratio));
    }
}
