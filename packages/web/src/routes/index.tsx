// Landing page: the projects this office runs, each a way into its board.
//
// There is no projects endpoint yet — no ticket in steps 1–3 owns one — so
// this reads the board's own project filter as the way in and otherwise
// says plainly that it has nothing to list. An empty page that explains
// itself beats a spinner that never resolves.
import { useEffect, useState } from "react";
import { ApiError, getBoard, type Board } from "../lib/api.ts";

export default function IndexRoute(): React.ReactElement {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getBoard()
      .then((result) => {
        if (!cancelled) setBoard(result);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(
          cause instanceof ApiError
            ? `${cause.message}`
            : `could not reach the event server: ${String(cause)}`,
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const total =
    board?.columns.reduce((count, column) => count + column.cards.length, 0) ?? 0;

  return (
    <section className="page">
      <h1>Office</h1>

      {error ? (
        <p className="page__error" role="alert">
          {error}
        </p>
      ) : null}

      {board ? (
        <p>
          {total === 0
            ? "No tasks yet. Management plans a batch, you review it, and Start working promotes it."
            : `${total} task${total === 1 ? "" : "s"} across ${board.columns.length} columns.`}
        </p>
      ) : null}

      <p>
        <a className="button" href="/tasks">
          Open the board
        </a>
      </p>

      <p className="page__note">
        Projects have no endpoint of their own until a later step, so this page cannot list them
        yet. The board takes a <code>project_id</code> filter in the meantime.
      </p>
    </section>
  );
}
