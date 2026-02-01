import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type FeedbackCategory = 'bug' | 'feature' | 'improvement' | 'question' | 'other';
export type FeedbackSentiment = 'positive' | 'negative' | 'neutral';

export interface FeedbackEntry {
  message: string;
  category: FeedbackCategory;
  sentiment: FeedbackSentiment;
  agentId?: string;
  toolName?: string;
  taskId?: string;
}

/**
 * Append a timestamped markdown entry to the feedback file.
 * Creates the file and parent directories if they do not exist.
 */
export function appendFeedback(feedbackFilePath: string, entry: FeedbackEntry): string {
  const absPath = resolve(feedbackFilePath);
  const dir = dirname(absPath);

  // Ensure directory exists
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // If file doesn't exist yet, write a header
  if (!existsSync(absPath)) {
    appendFileSync(absPath, '# Feedback\n\n', 'utf-8');
  }

  const timestamp = new Date().toISOString();

  // Build the markdown entry
  const lines: string[] = [];
  lines.push(`## ${timestamp}`);
  lines.push('');
  lines.push(`**Category:** ${entry.category}`);
  lines.push(`**Sentiment:** ${entry.sentiment}`);
  if (entry.agentId) {
    lines.push(`**Agent:** ${entry.agentId}`);
  }
  if (entry.toolName) {
    lines.push(`**Tool:** ${entry.toolName}`);
  }
  if (entry.taskId) {
    lines.push(`**Task:** ${entry.taskId}`);
  }
  lines.push('');
  lines.push(entry.message);
  lines.push('');
  lines.push('---');
  lines.push('');

  appendFileSync(absPath, lines.join('\n'), 'utf-8');

  return timestamp;
}

/**
 * Read all feedback from the feedback markdown file.
 * Returns the file contents, or a message if no feedback exists yet.
 */
export function readFeedback(feedbackFilePath: string): string {
  const absPath = resolve(feedbackFilePath);

  if (!existsSync(absPath)) {
    return 'No feedback has been recorded yet.';
  }

  return readFileSync(absPath, 'utf-8');
}
