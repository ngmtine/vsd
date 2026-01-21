#!/usr/bin/env node
import { Command } from "commander";
import { execa } from "execa";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const NULL_SHA = "0000000000000000000000000000000000000000";

type DiffEntry = {
    oldSha: string;
    newSha: string;
    status: string;
    oldPath: string;
    newPath: string;
};

const program = new Command();
program.name("vsd").description("Open git diff in VSCode diff editor").option("--staged", "Use staged changes (git diff --staged)").option("--exclude <paths...>", "Exclude paths from diff", []).allowUnknownOption(true).parse(process.argv);

const options = program.opts<{ staged?: boolean; exclude?: string[] }>();
const passthroughArgs = program.args;

async function main(): Promise<void> {
    const { preArgs, pathspecs } = splitArgs(passthroughArgs);
    const excludes = normalizeExcludes(options.exclude ?? []);
    const finalPreArgs = applyStagedFlag(preArgs, options.staged ?? false);

    const diffArgs = [...finalPreArgs, "--raw", "-z"];
    if (pathspecs.length > 0) {
        diffArgs.push("--", ...pathspecs);
    }

    const repoRoot = await getRepoRoot();
    console.log(`git diff ${diffArgs.join(" ")}`);
    const diffResult = await execa("git", ["diff", ...diffArgs], {
        stdout: "pipe",
        stderr: "pipe",
        reject: false,
    });

    if (diffResult.exitCode > 1) {
        const errorText = diffResult.stderr?.toString().trim();
        console.error(errorText.length > 0 ? errorText : "git diff failed.");
        process.exitCode = diffResult.exitCode;
        return;
    }

    const parsedEntries = parseRawDiff(diffResult.stdout);
    const entries = filterEntries(parsedEntries, excludes);
    console.log(`entries: ${parsedEntries.length}, after excludes: ${entries.length}`);
    if (entries.length === 0) {
        await printStagedHintIfNeeded(preArgs, excludes);
        if (parsedEntries.length > 0 && excludes.length > 0) {
            console.log("Excluded entries:");
            for (const entry of parsedEntries) {
                if (isExcluded(entry.oldPath, excludes) || isExcluded(entry.newPath, excludes)) {
                    console.log(`- ${formatEntry(entry)}`);
                }
            }
        }
        console.log(excludes.length > 0 ? "No changes (after excludes)." : "No changes.");
        return;
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vsd-"));

    for (let i = 0; i < entries.length; i += 1) {
        const entry = entries[i];
        console.log(formatEntry(entry));
        const leftContent = await readContent(entry.oldSha, entry.oldPath);

        const leftPath = await writeTempFile(tempDir, `left-${i}-${sanitizePath(entry.oldPath || entry.newPath)}`, leftContent);
        const rightPath = await resolveRightPath(repoRoot, tempDir, i, entry.newPath || entry.oldPath, entry.newSha);

        void leftPath;
        void rightPath;
        await execa("code", ["--diff", leftPath, rightPath], { stdio: "ignore" });
    }
}

function splitArgs(args: string[]): { preArgs: string[]; pathspecs: string[] } {
    const sepIndex = args.indexOf("--");
    if (sepIndex === -1) {
        return { preArgs: [...args], pathspecs: [] };
    }
    return {
        preArgs: args.slice(0, sepIndex),
        pathspecs: args.slice(sepIndex + 1),
    };
}

function normalizeExcludes(excludes: string[]): string[] {
    return excludes.map((value) => normalizeExclude(value)).filter((value) => value.length > 0);
}

function applyStagedFlag(args: string[], staged: boolean): string[] {
    if (!staged) {
        return [...args];
    }
    if (args.some((arg) => isStagedFlag(arg))) {
        return [...args];
    }
    return ["--staged", ...args];
}

function isStagedFlag(arg: string): boolean {
    return arg === "--staged" || arg === "--cached" || arg.startsWith("--staged=") || arg.startsWith("--cached=");
}

function filterEntries(entries: DiffEntry[], excludes: string[]): DiffEntry[] {
    if (excludes.length === 0) {
        return entries;
    }

    return entries.filter((entry) => !isExcluded(entry.oldPath, excludes) && !isExcluded(entry.newPath, excludes));
}

function normalizeExclude(value: string): string {
    let normalized = value.trim();
    if (normalized.startsWith(":(exclude)")) {
        normalized = normalized.slice(":(exclude)".length);
    }
    return normalizePath(normalized);
}

function isExcluded(filePath: string, excludes: string[]): boolean {
    if (!filePath) {
        return false;
    }
    const normalized = normalizePath(filePath);
    const segments = normalized.split("/");
    return excludes.some((exclude) => {
        if (!exclude) {
            return false;
        }
        if (exclude.includes("/")) {
            return normalized === exclude || normalized.startsWith(`${exclude}/`);
        }
        return segments.includes(exclude);
    });
}

function normalizePath(value: string): string {
    let normalized = value.replace(/\\/g, "/");
    normalized = normalized.replace(/^\.\//, "");
    normalized = normalized.replace(/^\/+/, "");
    normalized = normalized.replace(/\/+$/, "");
    return normalized;
}

function parseRawDiff(raw: string): DiffEntry[] {
    const entries: DiffEntry[] = [];
    const parts = raw.split("\0");
    let index = 0;

    while (index < parts.length) {
        const token = parts[index];
        if (!token) {
            index += 1;
            continue;
        }

        if (!token.startsWith(":")) {
            index += 1;
            continue;
        }

        let meta = token;
        let path1 = "";
        let path2 = "";

        if (token.includes("\t")) {
            const [metaPart, ...pathParts] = token.split("\t");
            meta = metaPart;
            path1 = pathParts[0] ?? "";
            path2 = pathParts[1] ?? "";
        } else {
            path1 = parts[index + 1] ?? "";
            index += 1;
        }

        const metaParts = meta.slice(1).split(" ");
        const oldSha = metaParts[2] ?? "";
        const newSha = metaParts[3] ?? "";
        const status = metaParts[4] ?? "";

        if ((status.startsWith("R") || status.startsWith("C")) && !path2) {
            path2 = parts[index + 1] ?? "";
            index += 1;
        }

        const oldPath = path1;
        const newPath = path2 || path1;

        entries.push({
            oldSha,
            newSha,
            status: status[0] ?? status,
            oldPath,
            newPath,
        });

        index += 1;
    }

    return entries;
}

async function readContent(sha: string, filePath: string): Promise<Buffer> {
    if (!sha || sha === NULL_SHA) {
        return Buffer.alloc(0);
    }

    try {
        const { stdout } = await execa("git", ["cat-file", "-p", sha], { encoding: null });
        return stdout as Buffer;
    } catch {
        return readWorktreeFile(filePath);
    }
}

async function readWorktreeFile(filePath: string): Promise<Buffer> {
    if (!filePath) {
        return Buffer.alloc(0);
    }

    try {
        return await fs.readFile(path.resolve(process.cwd(), filePath));
    } catch {
        return Buffer.alloc(0);
    }
}

async function writeTempFile(dir: string, name: string, content: Buffer): Promise<string> {
    const safeName = sanitizePath(name);
    const filePath = path.join(dir, safeName);
    await fs.writeFile(filePath, content);
    return filePath;
}

async function resolveRightPath(
    repoRoot: string,
    tempDir: string,
    index: number,
    filePath: string,
    sha: string
): Promise<string> {
    const absolutePath = filePath ? path.join(repoRoot, filePath) : "";
    if (absolutePath) {
        try {
            await fs.access(absolutePath);
            return absolutePath;
        } catch {
            // Fall back to temporary content if the file is missing.
        }
    }

    const content = await readContent(sha, filePath);
    return writeTempFile(tempDir, `right-${index}-${sanitizePath(filePath)}`, content);
}

function sanitizePath(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function formatEntry(entry: DiffEntry): string {
    if (entry.oldPath === entry.newPath) {
        return `${entry.status} ${entry.oldPath}`;
    }
    return `${entry.status} ${entry.oldPath} -> ${entry.newPath}`;
}

async function printStagedHintIfNeeded(preArgs: string[], excludes: string[]): Promise<void> {
    if (preArgs.some((arg) => isStagedFlag(arg))) {
        return;
    }
    if (preArgs.some((arg) => !arg.startsWith("-"))) {
        return;
    }

    const stagedResult = await execa("git", ["diff", "--raw", "-z", "--staged"], {
        stdout: "pipe",
        stderr: "pipe",
        reject: false,
    });

    if (stagedResult.exitCode > 1) {
        return;
    }

    const stagedEntries = filterEntries(parseRawDiff(stagedResult.stdout), excludes);
    if (stagedEntries.length === 0) {
        return;
    }

    console.log(`staged entries: ${stagedEntries.length} (use --staged)`);
    for (const entry of stagedEntries) {
        console.log(`S ${formatEntry(entry)}`);
    }
}

async function getRepoRoot(): Promise<string> {
    const result = await execa("git", ["rev-parse", "--show-toplevel"], {
        stdout: "pipe",
        stderr: "pipe",
        reject: false,
    });

    if (result.exitCode === 0) {
        return result.stdout.trim();
    }

    return process.cwd();
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
