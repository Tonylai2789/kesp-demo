import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import es from './es.json';

const resources = {
  en: { translation: en },
  es: { translation: es },
};

type SupportedLanguage = 'en' | 'es';

/** Documents the resolveSavedLanguage behavior. */
function resolveSavedLanguage(): SupportedLanguage {
  const savedLanguage = localStorage.getItem('language');
  return savedLanguage === 'en' || savedLanguage === 'es' ? savedLanguage : 'es';
}

// Get saved language from localStorage or default to Spanish to preserve KESP's current UX.
const savedLanguage = resolveSavedLanguage();

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: savedLanguage,
    fallbackLng: 'es',
    interpolation: {
      escapeValue: false,
    },
  });

// Save language preference when it changes
i18n.on('languageChanged', /** Handles the callback for this operation. */(lng) => {
  localStorage.setItem('language', lng);
});

export default i18n;
