/**
 * Translation helper (04-SPEC-frontend.md 6).
 *
 * The UI ships in English only, but no string is hardcoded in a component. That
 * is worth a context and a lookup function; it is not worth an i18n library for
 * one locale. Adding a second locale later means adding a JSON file and a
 * picker, nothing else.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import en from './locales/en.json';

export type Messages = Record<string, string>;

export type TranslateParams = Record<string, string | number>;

export type Translate = (key: string, params?: TranslateParams) => string;

const LOCALE = 'en';

function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

export function createTranslate(messages: Messages): Translate {
  return (key, params) => {
    const template = messages[key];
    if (template === undefined) {
      // A missing key is a bug, not a runtime condition to paper over. Surface
      // the key itself so it is obvious on screen and in any screenshot.
      if (import.meta.env.DEV) {
        throw new Error(`Missing translation key: ${key}`);
      }
      return key;
    }
    return interpolate(template, params);
  };
}

const I18nContext = createContext<Translate>(createTranslate(en as Messages));

export function I18nProvider({
  children,
  messages = en as Messages,
}: {
  children: ReactNode;
  messages?: Messages;
}): ReactNode {
  const t = useMemo(() => createTranslate(messages), [messages]);
  return <I18nContext.Provider value={t}>{children}</I18nContext.Provider>;
}

export function useT(): Translate {
  return useContext(I18nContext);
}

/** Dates and numbers go through Intl, never string concatenation. */
export const dateTimeFormat = new Intl.DateTimeFormat(LOCALE, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export const relativeTimeFormat = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });

export const numberFormat = new Intl.NumberFormat(LOCALE);
