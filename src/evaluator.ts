import vm from 'node:vm';
import { z } from 'zod';

export const CodingTaskPayloadSchema = z.object({
    description: z.string(),
    template: z.string().optional(),
    tests: z.array(
        z.object({
            input: z.unknown(),
            expected: z.unknown(),
        })
    ),
});
export type CodingTaskPayload = z.infer<typeof CodingTaskPayloadSchema>;

export function evaluateSubmission(
    payload: Record<string, unknown>,
    submission: string
): { success: true } | { success: false; reason: string } {
    // 1. Validate Payload
    const parsed = CodingTaskPayloadSchema.safeParse(payload);
    if (!parsed.success) {
        return { success: false, reason: 'invalid_task_payload' };
    }
    const task = parsed.data;

    // 2. Prepare Sandbox
    const sandbox: Record<string, any> = {
        console: { log: () => { } }, // Mute console
        module: { exports: {} as any },
    };
    sandbox.exports = sandbox.module.exports;
    const context = vm.createContext(sandbox);

    try {
        // 3. Load User Code
        // We wrap it in a function invocation or just run the script.
        // Assuming the user code defines the function or simply IS the function body?
        // Let's assume the user sends valid JS source that defines a function or returns a value.
        // Ideally, the user script should simply define the function name that matched the template or export it.
        // BUT since templates are optional, let's assume the script *evaluates* to the solution function.
        // e.g. "function solution(x) { return x*x; }; solution"

        const script = new vm.Script(submission);
        // Execute to get the function (assuming the script returns the function or declares it)
        // We'll enforce a convention: The script must result in a function being the last expression,
        // OR we inject a wrapper.
        // Let's try to interpret the script as returning the solver function.
        const result = script.runInContext(context, { timeout: 1000 });

        const solver =
            (typeof result === 'function' && result) ||
            (typeof sandbox.solve === 'function' && sandbox.solve) ||
            (typeof sandbox.solution === 'function' && sandbox.solution) ||
            (typeof sandbox.module?.exports === 'function' && sandbox.module.exports) ||
            (typeof sandbox.module?.exports?.solve === 'function' && sandbox.module.exports.solve) ||
            (typeof sandbox.exports === 'function' && sandbox.exports);

        if (typeof solver !== 'function') return { success: false, reason: 'submission_must_return_function' };

        // 4. Run Tests
        for (const test of task.tests) {
            try {
                const result = solver(test.input);

                // Simple equality check (JSON stringify for deep equality of arrays/objects)
                // This is a naive check; for production, use a proper assertion lib or deepEqual util.
                const resultJson = JSON.stringify(result);
                const expectedJson = JSON.stringify(test.expected);

                if (resultJson !== expectedJson) {
                    return {
                        success: false,
                        reason: `test_failed: input=${JSON.stringify(test.input)}, expected=${expectedJson}, got=${resultJson}`,
                    };
                }
            } catch (err) {
                return { success: false, reason: `runtime_error: ${(err as Error).message}` };
            }
        }

        return { success: true };
    } catch (err) {
        return { success: false, reason: `execution_error: ${(err as Error).message}` };
    }
}
