/**
 * A reference to a file of ANOTHER task (a lead showing what its subtask produced): `task:<id>/<file name>`. It is written into a message
 * (`![caption](task:ID/plan.png)`) or passed to show_images, and the dashboard / channels load the file from that task. Nothing is copied.
 */
export interface TaskFileRef {
  taskId: string;
  name: string;
}

export function parseTaskRef(ref: string): TaskFileRef | null {
  const m = /^task:([\w-]{1,64})\/([^/\\]{1,200})$/.exec(ref.trim());
  return m && m[2] !== '..' && !m[2]!.startsWith('.') ? { taskId: m[1]!, name: m[2]! } : null;
}

export const taskRef = (taskId: string, name: string): string => `task:${taskId}/${name}`;

/** show_images shows pictures: png, jpg, webp, gif (a document or a note is named in the message, it is not a picture to put in a chat album). */
export const isShowableImage = (name: string): boolean => /\.(png|jpe?g|webp|gif)$/i.test(name);
