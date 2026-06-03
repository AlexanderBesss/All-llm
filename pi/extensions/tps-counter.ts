/**
 * TPS Counter Extension
 *
 * Shows current tokens-per-second during streaming in the footer status area.
 * Uses a sliding window over the last 2 seconds for a smooth reading.
 * Session average counts only pure token generation time (excludes idle gaps and tool calls).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WINDOW_MS = 2000; // sliding window size in milliseconds

export default function (pi: ExtensionAPI) {
    // Timestamps of each token received (ms since epoch)
    let tokenTimestamps: number[] = [];
    let lastTps = 0;

    // Session-wide tracking — pure generation time only (no idle, no tool calls)
    let sessionTokenCount = 0;
    let sessionGenerationMs = 0; // cumulative ms spent receiving tokens across all streamed messages

    // Per-message streaming tracking
    let streamStartMs: number | null = null;
    let streamEndMs: number | null = null;

    pi.on("session_start", async (_event, ctx) => {
        sessionTokenCount = 0;
        sessionGenerationMs = 0;
        streamStartMs = null;
        streamEndMs = null;
        const theme = ctx.ui.theme;
        ctx.ui.setStatus("tps", theme.fg("dim", " -- t/s"));
    });

    pi.on("message_update", async (_event, ctx) => {
        const now = Date.now();

        // Record this token's arrival time
        tokenTimestamps.push(now);

        // Track streaming window for this message
        if (streamStartMs === null) {
            streamStartMs = now;
        }
        streamEndMs = now;

        // Count toward session total
        sessionTokenCount++;

        // Prune timestamps older than the window
        const cutoff = now - WINDOW_MS;
        while (tokenTimestamps.length > 0 && tokenTimestamps[0] < cutoff) {
            tokenTimestamps.shift();
        }

        // Calculate current TPS from tokens in the window
        if (tokenTimestamps.length >= 2) {
            const windowStart = tokenTimestamps[0];
            const elapsed = (now - windowStart) / 1000;
            if (elapsed > 0) {
                lastTps = Math.round(tokenTimestamps.length / elapsed);
            }
        } else if (tokenTimestamps.length === 1) {
            lastTps = tokenTimestamps.length;
        }

        // Calculate session average TPS (pure generation time)
        const sessionAvgTps = calculateSessionAvgTps();

        const theme = ctx.ui.theme;
        const tpsText = theme.fg("success", `${lastTps}`);
        const avgText = sessionAvgTps !== null
            ? ` ${theme.fg("muted", `avg ${sessionAvgTps}`)} t/s`
            : "";
        ctx.ui.setStatus("tps", ` ${tpsText} t/s${avgText}`);
    });

    pi.on("message_end", async (event, _ctx) => {
        // Only count assistant message streaming time
        if (event.message?.role !== "assistant") return;

        // Lock in this message's generation time
        if (streamStartMs !== null && streamEndMs !== null) {
            sessionGenerationMs += streamEndMs - streamStartMs;
        }

        // Reset for next streamed message
        streamStartMs = null;
        streamEndMs = null;
    });

    pi.on("agent_end", async (_event, ctx) => {
        const sessionAvgTps = calculateSessionAvgTps();
        const theme = ctx.ui.theme;

        if (sessionAvgTps !== null) {
            const avgText = theme.fg("muted", `avg ${sessionAvgTps}`);
            ctx.ui.setStatus("tps", ` ${theme.fg("dim", "--")} t/s ${avgText} t/s`);
        } else {
            ctx.ui.setStatus("tps", theme.fg("dim", " -- t/s"));
        }

        tokenTimestamps = [];
        lastTps = 0;
    });

    function calculateSessionAvgTps(): number | null {
        if (sessionTokenCount === 0) {
            return null;
        }
        // Combine locked-in generation time from completed messages
        // plus in-progress streaming time for the current message
        let totalGenerationMs = sessionGenerationMs;
        if (streamStartMs !== null && streamEndMs !== null) {
            totalGenerationMs += streamEndMs - streamStartMs;
        }
        if (totalGenerationMs <= 0) {
            return sessionTokenCount;
        }
        return Math.round(sessionTokenCount / (totalGenerationMs / 1000));
    }
}
