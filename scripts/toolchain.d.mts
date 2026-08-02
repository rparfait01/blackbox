/** Types for the ratified toolchain gate (Brief 35 Fix A §A). */
export interface ToolCheck {
  dir: string;
  tool: string;
  declared?: string;
  installed?: string;
  ok: boolean;
  problem: string | null;
}
export declare function satisfies(version: string, range: string): boolean;
export declare function checkTool(root: string, dir: string, tool: string): ToolCheck;
export declare const DEPLOY_TOOLCHAIN: Array<{ dir: string; tool: string }>;
export declare function checkDeployToolchain(root: string, pairs?: Array<{ dir: string; tool: string }>): ToolCheck[];
