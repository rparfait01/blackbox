export declare function stripComments(src: string): string;
export declare function code(absPath: string): string;
export declare function prose(absPath: string): string;
export declare function json(absPath: string): unknown;
export declare function exportsOf(absPath: string): string[];
export declare function callOrder(absPath: string, needles: string[]): Array<{ needle: string; index: number }>;
