/**
 * The small set of primitives every page is built from.
 *
 * These exist because four pages did not have them. Sources, Rules, Tags and
 * Settings were written in Phases 2 and 3, before the token system landed in
 * Phase 4, and they render as raw browser defaults: unstyled tables, unstyled
 * forms, default headings. Spreading Tailwind strings across those four files
 * would fix the look and guarantee the next page drifts again.
 *
 * Two rules hold here:
 *
 * 1. **Only semantic tokens.** Never a raw colour. The contrast suite measures
 *    the tokens, so anything that reaches past them is untested by construction.
 * 2. **Semantics unchanged.** A `Button` is a `<button>`, a `Field` associates
 *    its label with its control. Tests find things by role and accessible name,
 *    and so do screen readers; a primitive that breaks that is worse than none.
 */

import type { ButtonHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { useId, useState } from 'react';

/* -------------------------------------------------------------------------- */
/* Buttons                                                                     */
/* -------------------------------------------------------------------------- */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover border border-transparent',
  secondary: 'border-subtle text-secondary hover:bg-hovered hover:text-primary border',
  ghost: 'text-secondary hover:bg-hovered hover:text-primary border border-transparent',
  // Destructive actions read as destructive before they are clicked, not after.
  danger: 'text-negative hover:bg-hovered border border-transparent',
};

const SIZE: Record<ButtonSize, string> = {
  sm: 'px-2 py-1 text-xs',
  md: 'px-3 py-1.5 text-sm',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  type = 'button',
  ...rest
}: ButtonProps): ReactNode {
  return (
    <button
      // Explicit: a `<button>` inside a form defaults to submit, which turns
      // "Delete" into "save the form" the first time someone presses Enter.
      type={type}
      className={[
        'rounded font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        VARIANT[variant],
        SIZE[size],
        className,
      ].join(' ')}
      {...rest}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Form fields                                                                 */
/* -------------------------------------------------------------------------- */

const CONTROL =
  'bg-surface border-subtle text-primary w-full rounded border px-2 py-1.5 text-sm ' +
  'disabled:opacity-60';

interface FieldShellProps {
  label: string;
  /** Rendered under the control and wired with aria-describedby, never inside the label. */
  hint?: string;
  error?: string;
  children: (props: { id: string; describedBy: string | undefined }) => ReactNode;
  className?: string;
}

/**
 * A label, a control, and optionally a hint.
 *
 * The hint is attached with `aria-describedby` rather than nested in the label:
 * nesting makes the field's accessible name "New passwordAt least 12 characters",
 * which is what a screen reader then announces. That was a real bug once.
 */
export function Field({
  label,
  hint,
  error,
  children,
  className = '',
}: FieldShellProps): ReactNode {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint === undefined ? null : hintId, error === undefined ? null : errorId]
      .filter((value): value is string => value !== null)
      .join(' ') || undefined;

  return (
    <div className={className}>
      <label htmlFor={id} className="text-secondary mb-1 block text-sm">
        {label}
      </label>
      {children({ id, describedBy })}
      {hint !== undefined && (
        <p id={hintId} className="text-muted mt-1 text-xs">
          {hint}
        </p>
      )}
      {error !== undefined && (
        <p id={errorId} role="alert" className="text-negative mt-1 text-xs">
          {error}
        </p>
      )}
    </div>
  );
}

export function TextField({
  label,
  hint,
  error,
  className,
  ...rest
}: {
  label: string;
  hint?: string;
  error?: string;
} & InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return (
    <Field
      label={label}
      {...(hint === undefined ? {} : { hint })}
      {...(error === undefined ? {} : { error })}
    >
      {({ id, describedBy }) => (
        <input
          id={id}
          aria-describedby={describedBy}
          aria-invalid={error === undefined ? undefined : true}
          className={[CONTROL, className ?? ''].join(' ')}
          {...rest}
        />
      )}
    </Field>
  );
}

export function SelectField({
  label,
  hint,
  children,
  className,
  ...rest
}: {
  label: string;
  hint?: string;
  children: ReactNode;
} & SelectHTMLAttributes<HTMLSelectElement>): ReactNode {
  return (
    <Field label={label} {...(hint === undefined ? {} : { hint })}>
      {({ id, describedBy }) => (
        <select
          id={id}
          aria-describedby={describedBy}
          className={[CONTROL, className ?? ''].join(' ')}
          {...rest}
        >
          {children}
        </select>
      )}
    </Field>
  );
}

export function TextAreaField({
  label,
  hint,
  className,
  ...rest
}: { label: string; hint?: string } & TextareaHTMLAttributes<HTMLTextAreaElement>): ReactNode {
  return (
    <Field label={label} {...(hint === undefined ? {} : { hint })}>
      {({ id, describedBy }) => (
        <textarea
          id={id}
          aria-describedby={describedBy}
          className={[CONTROL, className ?? ''].join(' ')}
          {...rest}
        />
      )}
    </Field>
  );
}

/** A checkbox reads better with its label after it, so it is its own shape. */
export function CheckboxField({
  label,
  className = '',
  ...rest
}: { label: string } & InputHTMLAttributes<HTMLInputElement>): ReactNode {
  return (
    <label className={`text-secondary flex cursor-pointer items-center gap-2 text-sm ${className}`}>
      <input type="checkbox" className="accent-[var(--accent)]" {...rest} />
      {label}
    </label>
  );
}

/* -------------------------------------------------------------------------- */
/* Page and panel structure                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A page's intro and its page-level actions.
 *
 * `title` is optional and usually omitted: the page's name is rendered once, by
 * `PageBar`, and a second heading directly beneath it saying the same word is
 * noise. What is left here is the description and the actions, which are the
 * parts that differ per page.
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
}): ReactNode {
  if (title === undefined && description === undefined && actions === undefined) return null;

  return (
    <header className="mb-5 flex flex-wrap items-start gap-3">
      <div className="mr-auto">
        {title !== undefined && <h1 className="text-primary text-xl font-semibold">{title}</h1>}
        {description !== undefined && (
          <p className="text-secondary max-w-prose text-sm">{description}</p>
        )}
      </div>
      {actions}
    </header>
  );
}

export function Panel({
  title,
  description,
  children,
  className = '',
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <section className={`bg-surface border-subtle rounded-lg border p-4 ${className}`}>
      {title !== undefined && <h2 className="text-primary text-base font-semibold">{title}</h2>}
      {description !== undefined && (
        <p className="text-secondary mt-1 max-w-prose text-sm">{description}</p>
      )}
      <div className={title === undefined ? '' : 'mt-3'}>{children}</div>
    </section>
  );
}

/**
 * An empty state is an invitation, not a blank box.
 *
 * `action` is deliberately part of the shape: every empty list in this app should
 * say what to do next, and making it awkward to omit is the point.
 */
export function EmptyState({
  message,
  action,
}: {
  message: string;
  action?: ReactNode;
}): ReactNode {
  return (
    <div className="border-subtle rounded-lg border border-dashed px-4 py-8 text-center">
      <p className="text-secondary text-sm">{message}</p>
      {action !== undefined && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Notice({
  tone,
  children,
}: {
  tone: 'info' | 'success' | 'warning' | 'error';
  children: ReactNode;
}): ReactNode {
  const colour = {
    info: 'text-secondary',
    success: 'text-positive',
    warning: 'text-warning',
    error: 'text-negative',
  }[tone];

  return (
    <p role={tone === 'error' ? 'alert' : 'status'} className={`${colour} text-sm`}>
      {children}
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/* Tables                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Wrapped in its own horizontal scroller.
 *
 * A wide table must scroll inside itself; letting the page scroll sideways
 * breaks every other column on the screen.
 */
export function Table({ head, children }: { head: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="border-subtle overflow-x-auto rounded-lg border">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-raised">
          <tr className="border-subtle border-b">{head}</tr>
        </thead>
        <tbody className="divide-subtle divide-y">{children}</tbody>
      </table>
    </div>
  );
}

export function TH({
  children,
  align = 'left',
}: {
  children: ReactNode;
  align?: 'left' | 'right';
}): ReactNode {
  return (
    <th
      scope="col"
      className={`text-muted px-3 py-2 text-xs font-medium tracking-wide uppercase ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}

export function TR({ children }: { children: ReactNode }): ReactNode {
  return <tr className="hover:bg-hovered transition-colors">{children}</tr>;
}

export function TD({
  children,
  align = 'left',
  className = '',
}: {
  children: ReactNode;
  align?: 'left' | 'right';
  className?: string;
}): ReactNode {
  return (
    <td
      className={`text-primary px-3 py-2 align-middle ${
        align === 'right' ? 'text-right tabular-nums' : ''
      } ${className}`}
    >
      {children}
    </td>
  );
}

/* -------------------------------------------------------------------------- */
/* Thumbnails                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * An item's preview image, hotlinked from wherever it lives.
 *
 * Four things are deliberate:
 *
 * - `referrerPolicy="no-referrer"`. Several CDNs -- Reddit's `preview.redd.it`
 *   among them -- refuse a request that names another site as its referer, and
 *   sending one leaks the reading history anyway.
 * - `loading="lazy"`. A page of fifty cards must not open fifty connections.
 * - A fixed box with `object-cover`. Reserving the space stops the list from
 *   reflowing as images arrive, which is what makes a feed unreadable while it
 *   loads.
 * - `onError` hides it. A dead thumbnail is very common -- articles move, CDNs
 *   expire signed URLs -- and a broken-image icon is worse than no image.
 */
export function Thumbnail({
  src,
  className = '',
}: {
  src: string | null;
  className?: string;
}): ReactNode {
  const [failed, setFailed] = useState(false);

  if (src === null || failed) return null;

  return (
    <img
      src={src}
      alt=""
      // Decorative: the title next to it already names the item, and announcing
      // a filename would only add noise.
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={`bg-raised h-full w-full rounded object-cover ${className}`}
    />
  );
}

/**
 * A source's icon: its favicon, its feed image, or a subreddit's avatar.
 *
 * Deliberately not the same component as `Thumbnail`, and deliberately not a
 * substitute for one. A thumbnail previews *this article*; an icon identifies
 * the source and is identical on every item from it. Rendering the icon in the
 * thumbnail's place at the thumbnail's size would fill the image column with
 * something that never varies, which is worse than an empty box: it draws the
 * eye and then says nothing.
 *
 * `contain`, not `cover` — these are logos with their own padding and cropping
 * them to a square is how a wordmark loses its first and last letter.
 */
export function SourceIcon({
  src,
  size = 'sm',
  className = '',
}: {
  src: string | null;
  /** `sm` sits beside a source name; `lg` fills a card's empty image box. */
  size?: 'sm' | 'lg';
  className?: string;
}): ReactNode {
  const [failed, setFailed] = useState(false);

  // A guessed `/favicon.ico` is often a 404, so failing is the normal case here,
  // not the exotic one.
  if (src === null || failed) return null;

  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={[
        'shrink-0 rounded object-contain',
        size === 'sm' ? 'h-4 w-4' : 'h-10 w-10',
        className,
      ].join(' ')}
    />
  );
}

/** Monospace, for slugs, patterns and anything the user must copy exactly. */
export function Mono({ children }: { children: ReactNode }): ReactNode {
  return <code className="bg-raised text-secondary rounded px-1 py-0.5 text-xs">{children}</code>;
}
