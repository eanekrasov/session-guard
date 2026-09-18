import type {
  ChangeAfterInput,
  ChangeBeforeInput,
  ChangeEnforcement,
} from './change-enforcement.ts';
import type { TaskAdmission, TaskAdmissionInput } from './task-admission.ts';
import type { WorkflowSession } from '../session/session-schema.ts';

export interface ToolPolicyInput {
  tool: string;
  sessionID: string;
  callID: string;
  args: unknown;
  session?: WorkflowSession;
  output?: { args: unknown };
}

export interface ToolPolicyPorts {
  guardrails(input: ToolPolicyInput): Promise<void>;
  rules(input: ToolPolicyInput): Promise<void>;
  consent(input: ToolPolicyInput): Promise<boolean>;
  taskAdmission?: TaskAdmission;
  changeEnforcement?: ChangeEnforcement;
  taskInput?(input: ToolPolicyInput): TaskAdmissionInput;
  changeBeforeInput?(input: ToolPolicyInput): ChangeBeforeInput;
  changeAfterInput?(input: ToolPolicyInput, output: ChangeAfterInput['output']): ChangeAfterInput;
  scope(input: ToolPolicyInput): Promise<void>;
  actions(input: ToolPolicyInput): Promise<void>;
  delivery(input: ToolPolicyInput): Promise<void>;
  mutation(input: ToolPolicyInput): Promise<void>;
  after?(input: ToolPolicyInput, output: ChangeAfterInput['output']): Promise<void>;
}

export interface ToolExecutionPolicy {
  before(input: ToolPolicyInput): Promise<void>;
  after(input: ToolPolicyInput, output: ChangeAfterInput['output']): Promise<void>;
}

export function createToolExecutionPolicy(ports: ToolPolicyPorts): ToolExecutionPolicy {
  return {
    async before(input) {
      await ports.guardrails(input);
      await ports.rules(input);
      if (await ports.consent(input)) return;
      if (ports.taskAdmission?.isWorkflowTask(input.tool, input.args)) {
        if (!ports.taskInput) throw new Error('Task admission input adapter is missing');
        await ports.taskAdmission.before(ports.taskInput(input));
      }
      if (ports.changeEnforcement && ports.changeBeforeInput) {
        await ports.changeEnforcement.before(ports.changeBeforeInput(input));
      } else {
        await ports.scope(input);
        await ports.actions(input);
        await ports.delivery(input);
        await ports.mutation(input);
      }
    },
    async after(input, output) {
      if (ports.after) await ports.after(input, output);
      if (ports.changeEnforcement && ports.changeAfterInput) {
        await ports.changeEnforcement.after(ports.changeAfterInput(input, output));
      }
    },
  };
}
