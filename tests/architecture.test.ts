// Static rules about where code may go. They read the source files; nothing is executed.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir))) {
    const path = join(dir, entry);
    if (statSync(join(ROOT, path)).isDirectory()) out.push(...walk(path));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(relative(ROOT, join(ROOT, path)).split(sep).join("/"));
  }
  return out;
}

const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
const SRC = walk("src");
const SOURCE = SRC.filter((f) => !/\.test\.tsx?$/.test(f));
const ROUTES = SOURCE.filter((f) => /^src\/app\/api\/.*\/route\.ts$/.test(f));
const ALL = [...SRC, ...walk("tests"), ...walk("prisma")];

/** Files that match a pattern, as "file" strings, for readable failures. */
const matching = (files: string[], pattern: RegExp) => files.filter((f) => pattern.test(read(f)));

describe("time (R69)", () => {
  it("only src/domain/time.ts imports the time zone library", () => {
    expect(matching(ALL, /from\s+["']@js-temporal\/polyfill["']|require\(["']@js-temporal/)).toEqual([
      "src/domain/time.ts",
    ]);
  });

  it("no other source file formats or converts with a time zone", () => {
    const offenders = matching(
      SOURCE.filter((f) => f !== "src/domain/time.ts"),
      /toLocale(Date|Time)?String\(|getTimezoneOffset\(|Intl\.DateTimeFormat/,
    );
    expect(offenders).toEqual([]);
  });
});

describe("src/domain is pure logic", () => {
  const DOMAIN = SRC.filter((f) => f.startsWith("src/domain/"));

  it("has no database import", () => {
    expect(matching(DOMAIN, /@\/lib\/db|generated\/prisma|@prisma\/|from\s+["']pg["']/)).toEqual([]);
  });

  it("imports nothing from src/lib or src/app", () => {
    expect(matching(DOMAIN, /from\s+["'](@\/lib\/|@\/app\/|\.\.\/lib\/|\.\.\/app\/)/)).toEqual([]);
  });
});

describe("the database client", () => {
  it("is created in src/lib/db.ts and nowhere else in src", () => {
    expect(matching(SOURCE, /generated\/prisma|new PrismaClient\(|@prisma\/adapter-pg/)).toEqual(["src/lib/db.ts"]);
  });

  it("is never imported by a component or a page", () => {
    const ui = SOURCE.filter((f) => f.startsWith("src/components/") || f === "src/lib/api-client.ts");
    expect(matching(ui, /@\/lib\/(db|session|logger|audit)["']/)).toEqual([]);
  });
});

describe("appointment status (CLAUDE.md: never set status directly)", () => {
  const CORE = "src/lib/appointments/core.ts";

  it("only the core inserts, updates or deletes appointments", () => {
    const writes =
      /\.appointment\.(create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)\(|(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"Appointment"/i;
    expect(matching(SOURCE, writes)).toEqual([CORE]);
  });

  it("the core checks every status change against src/domain/transitions.ts", () => {
    const core = read(CORE);
    expect(core).toContain('from "@/domain/transitions"');
    expect(core.match(/checkTransition\(/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("the core never retries a booking conflict", () => {
    // With comments removed, the core has no loop and nothing named retry.
    const code = read(CORE).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bretr(y|ies)\b|\bwhile\s*\(|\bfor\s*\(/i);
  });
});

describe("route handlers", () => {
  it("there are route handlers to check", () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(4);
  });

  it("every route is built with the wrapper, which runs authenticate, authorize, validate, act", () => {
    for (const file of ROUTES) {
      const text = read(file);
      const exports = text.match(/^export\s+.*$/gm) ?? [];
      expect(exports.length, file).toBeGreaterThan(0);
      for (const line of exports) {
        expect(line, file).toMatch(/^export const (GET|POST|PUT|PATCH|DELETE) = route\(\{$/);
      }
      expect(text, file).toContain('from "@/lib/route"');
    }
  });

  it("no route touches the database, the session or the response itself", () => {
    const forbidden = /@\/lib\/db["']|@\/lib\/session["']|generated\/prisma|new Response\(|Response\.json\(|NextResponse|getSession\(/;
    expect(matching(ROUTES, forbidden)).toEqual([]);
  });

  it("every route that returns an appointment responds through the serializer (R83)", () => {
    const appointmentRoutes = ROUTES.filter((f) => f.includes("/appointments/"));
    expect(appointmentRoutes.length).toBeGreaterThanOrEqual(4);
    for (const file of appointmentRoutes) {
      const text = read(file);
      expect(text, file).toContain('from "@/lib/serialize"');
      expect(text, file).toMatch(/appointment: await readAppointment\(/);
    }
  });

  it("only the serializer reads whole appointment rows for a response", () => {
    const offenders = matching(
      SOURCE.filter((f) => f !== "src/lib/serialize.ts"),
      /appointmentInclude|\.appointment\.find\w+\(\s*\{[^}]*include:\s*\{\s*patient/,
    );
    expect(offenders).toEqual([]);
  });
});

describe("logging (R78)", () => {
  it("nothing in src uses console", () => {
    expect(matching(SOURCE, /\bconsole\.(log|info|warn|error|debug|trace)\(/)).toEqual([]);
  });

  it("only the logger writes to standard output", () => {
    expect(matching(SOURCE, /process\.(stdout|stderr)\.write\(/)).toEqual(["src/lib/logger.ts"]);
  });

  it("the logger takes an event and ids: it has no message or payload parameter", () => {
    const logger = read("src/lib/logger.ts");
    const signatures = logger.match(/(info|warn|error): \(([^)]*)\)/g) ?? [];
    expect(signatures).toHaveLength(3);
    for (const signature of signatures) expect(signature).toMatch(/\(event: string, ids\?: LogIds\)$/);
  });
});

describe("claims (R85)", () => {
  it("no source text claims the system complies with any regulation", () => {
    const claims = /\b(HIPAA|GDPR|PIPEDA|compliant|compliance|complies|certified)\b/i;
    expect(matching([...SOURCE, ...walk("prisma")], claims)).toEqual([]);
  });
});

describe("free text (CLAUDE.md: reason codes, not free-text reasons)", () => {
  it("the only free-text reason in the schema is the patient's reason for visit (R20)", () => {
    const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
    const textReasons = schema
      .split("\n")
      .filter((line) => /^\s+\w*[Rr]eason\w*\s+String/.test(line))
      .map((line) => line.trim().split(/\s+/)[0]);
    expect(textReasons).toEqual(["reasonForVisit"]);
  });
});
