import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { AuthFileItem } from '@/types';
import styles from './SubscriptionOverview.module.scss';

export function SubscriptionOverview({
  files,
  loading,
}: {
  files: AuthFileItem[];
  loading: boolean;
}) {
  const { t } = useTranslation();
  return (
    <section aria-label={t('quota_management.title')}>
      <p className={styles.intro}>{t('fleet_console.intro')}</p>
      <div className={styles.grid}>
        {(['codex', 'claude'] as const).map((provider) => {
          const accounts = files.filter((file) => (file.type ?? file.provider) === provider);
          return (
            <article key={provider} className={styles.card}>
              <div>
                <h2>{provider === 'codex' ? 'Codex' : 'Claude'}</h2>
                <p>
                  {loading
                    ? '…'
                    : accounts.length
                      ? t('fleet_console.connected', {
                          count: accounts.length,
                          enabled: accounts.filter((file) => !file.disabled).length,
                        })
                      : t('fleet_console.no_accounts')}
                </p>
              </div>
              <Link to={accounts.length ? '/auth-files' : '/oauth'}>
                {t(accounts.length ? 'fleet_console.manage_accounts' : 'fleet_console.add_account')}{' '}
                →
              </Link>
            </article>
          );
        })}
      </div>
    </section>
  );
}
