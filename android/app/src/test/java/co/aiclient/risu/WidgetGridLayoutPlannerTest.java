package co.aiclient.risu;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class WidgetGridLayoutPlannerTest {
    @Test
    public void tallWidgetUsesMultipleRowsForThreePortraitCards() {
        WidgetGridLayoutPlanner.Plan plan = WidgetGridLayoutPlanner.choose(
            320,
            700,
            new float[] { 1.45f, 1.40f, 1.50f }
        );

        assertEquals(2, plan.columns);
        assertTrue(plan.itemColumns[0] != plan.itemColumns[2] || plan.itemColumns[1] != plan.itemColumns[2]);
    }

    @Test
    public void shallowWidgetFallsBackToSingleRowWhenNeeded() {
        WidgetGridLayoutPlanner.Plan plan = WidgetGridLayoutPlanner.choose(
            320,
            180,
            new float[] { 1.45f, 1.40f, 1.50f }
        );

        assertEquals(3, plan.columns);
    }
}
