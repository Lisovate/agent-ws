import { describe, it, expect } from "vitest";
import { cleanOutput } from "../src/process/output-cleaner.js";

describe("cleanOutput", () => {
  it("returns plain text unchanged", () => {
    expect(cleanOutput("Hello, world!")).toBe("Hello, world!");
  });

  it("removes ANSI color codes", () => {
    expect(cleanOutput("\x1B[31mred text\x1B[0m")).toBe("red text");
  });

  it("removes ANSI bold/underline", () => {
    expect(cleanOutput("\x1B[1mbold\x1B[0m \x1B[4munderline\x1B[0m")).toBe("bold underline");
  });

  it("removes cursor movement sequences", () => {
    expect(cleanOutput("\x1B[2Jhello\x1B[H")).toBe("hello");
  });

  it("removes OSC sequences (title changes)", () => {
    expect(cleanOutput("\x1B]0;title\x07content")).toBe("content");
  });

  it("removes CSI with private parameter prefix that stripVTControlCharacters misparses", () => {
    // \x1B[<u is a CSI sequence with private param '<' and final byte 'u'.
    // Node's stripVTControlCharacters treats '<' as the final byte, leaving 'u' behind.
    expect(cleanOutput("\x1B[<u")).toBe("");
  });

  it("removes CSI private param sequences embedded in content", () => {
    expect(cleanOutput("hello\x1B[<uworld")).toBe("helloworld");
  });

  it("removes the exact Claude CLI exit sequence", () => {
    // Real sequence captured from PTY: \x1B[<u \x1B[?1004l \x1B[?2004l \x1B[?25h \x1B]9;4;0;\x07
    const cliExit = "\x1B[<u\x1B[?1004l\x1B[?2004l\x1B[?25h\x1B]9;4;0;\x07";
    expect(cleanOutput(cliExit)).toBe("");
  });

  it("removes BEL characters", () => {
    expect(cleanOutput("beep\x07boop")).toBe("beepboop");
  });

  it("removes carriage returns", () => {
    expect(cleanOutput("line1\r\nline2\r\n")).toBe("line1\nline2\n");
  });

  it("handles mixed ANSI codes, CR, and BEL", () => {
    const dirty = "\x1B[32m\x07hello\r\n\x1B[0mworld\x07\r";
    expect(cleanOutput(dirty)).toBe("hello\nworld");
  });

  it("handles 256-color ANSI codes", () => {
    expect(cleanOutput("\x1B[38;5;196mcolored\x1B[0m")).toBe("colored");
  });

  it("handles RGB ANSI codes", () => {
    expect(cleanOutput("\x1B[38;2;255;0;0mrgb\x1B[0m")).toBe("rgb");
  });

  it("returns empty string for empty input", () => {
    expect(cleanOutput("")).toBe("");
  });

  it("handles only control characters", () => {
    expect(cleanOutput("\x1B[0m\r\x07")).toBe("");
  });

  it("preserves newlines", () => {
    expect(cleanOutput("line1\nline2\nline3")).toBe("line1\nline2\nline3");
  });

  it("handles erase line sequences", () => {
    expect(cleanOutput("\x1B[2Khello")).toBe("hello");
  });
});
