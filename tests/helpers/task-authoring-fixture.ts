type FullTask = {
  id: string;
  depends_on?: string[];
  execution?: Record<string, { applicability?: string; [key: string]: unknown }>;
  [key: string]: unknown;
};

/**
 * Test-only migration helper for historical full task-plan fixtures. It makes
 * the authoring contract explicit while preserving each fixture's dependency
 * graph and step applicability.
 */
export function taskAuthoringFixture(payload: { tasks: FullTask[]; [key: string]: unknown }): {
  tasks: Record<string, unknown>[];
} {
  const localIds = new Set(payload.tasks.map((task) => task.id));
  return {
    tasks: payload.tasks.map((task) => {
      const {
        id,
        status: _status,
        execution,
        red_test_registered: _redRegistered,
        depends_on: dependencies = [],
        ...body
      } = task;
      const stepPolicy =
        execution === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(execution).flatMap(([step, state]) =>
                state.applicability === undefined ? [] : [[step, state.applicability]],
              ),
            );
      return {
        ...body,
        local_key: id,
        depends_on: dependencies.map((dependency) =>
          localIds.has(dependency) ? { local_key: dependency } : { task_id: dependency },
        ),
        ...(stepPolicy === undefined ? {} : { step_policy: stepPolicy }),
      };
    }),
  };
}
