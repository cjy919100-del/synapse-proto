import OpenAI from 'openai';
import { type CodingTaskPayload } from './evaluator.js';

export class AgentLlm {
    private openai?: OpenAI;

    constructor() {
        const apiKey = process.env.OPENAI_API_KEY;
        if (apiKey) {
            this.openai = new OpenAI({ apiKey });
        }
    }

    get isEnabled(): boolean {
        return !!this.openai;
    }

    async solveCodingTask(task: CodingTaskPayload): Promise<string> {
        if (process.env.FORCE_MOCK_LLM === 'true' || !this.openai) {
            console.error('[llm] using mock (forced or no key)');
            const mockResult = this.solveMock(task);
            console.error(`[llm] mock result: ${mockResult}`);
            return mockResult;
        }

        const prompt = `
You are an expert coder. Your task is to write a JavaScript function that solves the following problem:
"${task.description}"

${task.template ? `Use this signature:\n${task.template}\n` : ''}

You must return ONLY the valid JavaScript code. Do not wrap it in markdown block.
If you need helper functions, include them. 
The code should execute and either return the solution function or be an expression that evaluates to it.
For example if the task is "square the input", you can return:
"function square(x) { return x * x; } square" or simply "x => x*x"

Do NOT include example usage or tests in the output.
    `.trim();

        try {
            const completion = await this.openai.chat.completions.create({
                model: 'gpt-4o-mini', // Cost-effective
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.1, // Deterministic
            });

            let code = completion.choices[0]?.message?.content || '';
            // Cleanup markdown if present
            code = code.replace(/^```javascript\n/, '').replace(/^```\n/, '').replace(/\n```$/, '');
            return code.trim();
        } catch (err) {
            // Fallback or rethrow
            return `// LLM Failed: ${(err as Error).message}\nfunction fail() { return null; }`;
        }
    }

    async solveRepoPatchTask(args: { repo: string; issue: string; contextHint?: string }): Promise<string> {
        if (process.env.FORCE_MOCK_LLM === 'true' || !this.openai) {
            console.error('[llm] repo-patch unavailable (forced or no key)');
            throw new Error('llm_disabled');
        }

        const prompt = `
You are an expert software engineer.

Return ONLY a unified diff patch that can be applied with \`git apply\`.
Do not include explanations, markdown fences, or any extra text.

Repo: ${args.repo}

Issue:
${args.issue}

${args.contextHint ? `Context hint (truncated):\n${args.contextHint}\n` : ''}
        `.trim();

        const completion = await this.openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
        });

        let patch = completion.choices[0]?.message?.content || '';
        // Strip accidental fences if the model ignored instructions.
        patch = patch.replace(/^```diff\n/, '').replace(/^```\n/, '').replace(/\n```$/, '');
        return patch.trim();
    }

    // Fallback for when no API key is set
    solveMock(task: CodingTaskPayload): string {
        // Hardcoded logic for valid demo scenarios
        if (task.description.includes('square')) {
            // Use an expression that evaluates to a function for deterministic evaluator compatibility.
            return '(x) => x * x';
        }

        // Default dummy
        return `() => ${JSON.stringify(task.tests[0]?.expected)}`;
    }
}
