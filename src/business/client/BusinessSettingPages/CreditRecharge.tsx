'use client';

import { type CreditProduct } from '@/business/server/credits/products';
import { type UserCreditAccountItem, type CreditLedgerEntryItem } from '@/database/schemas/credit';
import { Button, Flexbox } from '@lobehub/ui';
import useSWR from 'swr';
import useSWRMutation from 'swr/mutation';
import { Card, Empty, Modal, message, Table, Tag } from 'antd';
import { createStaticStyles } from 'antd-style';
import { CheckCircle2, ExternalLink, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { subscriptionService } from '@/services/subscription';
import { lambdaQuery } from '@/libs/trpc/client';
import SettingHeader from '@/routes/(main)/settings/features/SettingHeader';

const styles = createStaticStyles(({ css }) => ({
  container: css`
    display: flex;
    flex-direction: column;
    gap: 24px;
    padding: 24px;
  `,
  balanceCard: css`
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    padding: 24px;
    border-radius: 12px;
  `,
  balanceTitle: css`
    font-size: 14px;
    opacity: 0.9;
    margin-bottom: 8px;
  `,
  balanceValue: css`
    font-size: 32px;
    font-weight: bold;
  `,
  packagesSection: css`
    margin-top: 16px;
  `,
  packageGrid: css`
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 16px;
    margin-top: 16px;
  `,
  packageCard: css`
    border: 2px solid transparent;
    transition: all 0.2s ease;
    cursor: pointer;

    &:hover {
      border-color: #667eea;
      transform: translateY(-2px);
    }

    &[data-selected='true'] {
      border-color: #667eea;
      background: #f0f4ff;
    }
  `,
  packageHeader: css`
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;
  `,
  packageTitle: css`
    font-weight: 600;
    font-size: 16px;
  `,
  packageCredits: css`
    font-size: 24px;
    font-weight: bold;
    color: #667eea;
  `,
  packagePrice: css`
    font-size: 18px;
    color: #666;
    margin-bottom: 12px;
  `,
  historySection: css`
    margin-top: 32px;
  `,
  historyTitle: css`
    font-size: 18px;
    font-weight: 600;
    margin-bottom: 16px;
  `,
  empty: css`
    padding-block: 48px;
    padding-inline: 0;
  `,
}));

const CreditRecharge = () => {
  const { t } = useTranslation('subscription');
  const [selectedPackage, setSelectedPackage] = useState<string | null>(null);
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);

  // Fetch credit products using SWR
  const { data: creditProducts, isLoading: isLoadingProducts, error: productsError } = useSWR(
    ['subscription', 'creditProducts'],
    () => subscriptionService.getCreditProducts(),
  );

  // Fetch credit account using SWR
  const { data: creditAccount, isLoading: isLoadingAccount, error: accountError } = useSWR(
    ['subscription', 'myCreditAccount'],
    () => subscriptionService.getMyCreditAccount(),
  );

  // Fetch ledger entries using TRPC (keep as-is)
  const { data: ledgerEntries, isLoading: isLoadingHistory } = lambdaQuery.subscription.listLedgerEntries.useQuery(
    { limit: 20 },
  );

  // Recharge mutation using SWR
  const { trigger: recharge, isMutating: isRecharging } = useSWRMutation(
    ['subscription', 'recharge'],
    async (_: [string, string], { arg: productId }: { arg: string }) =>
      subscriptionService.createCreditRechargeOrder(productId),
    {
      onSuccess: (data: { orderId: string; paymentUrl: string }) => {
        message.success(t('credits.recharge.redirecting'));
        setTimeout(() => {
          window.open(data.paymentUrl, '_blank');
        }, 500);
        setConfirmModalOpen(false);
      },
      onError: () => {
        message.error(t('credits.recharge.rechargeError'));
      },
    },
  );

  const handlePackageSelect = (productId: string) => {
    setSelectedPackage(productId);
  };

  const handleRecharge = () => {
    if (selectedPackage) {
      setConfirmModalOpen(true);
    }
  };

  const handleConfirmRecharge = () => {
    if (selectedPackage) {
      recharge(selectedPackage);
    }
  };

  const formatPrice = (priceCny: number) => `¥${priceCny.toFixed(2)}`;

  const formatDate = (date: string) => {
    return new Date(date).toLocaleString();
  };

  const formatAmount = (amount: number) => {
    return amount > 0 ? `+${amount}` : amount;
  };

  const renderTypeTag = (type: string) => {
    const colors: Record<string, string> = {
      recharge: 'green',
      usage: 'red',
      adjustment: 'blue',
    };

    const labels: Record<string, string> = {
      recharge: t('credits.recharge.history.type.recharge'),
      usage: t('credits.recharge.history.type.usage'),
      adjustment: t('credits.recharge.history.type.adjustment'),
    };

    return <Tag color={colors[type]}>{labels[type]}</Tag>;
  };

  const historyColumns = [
    {
      dataIndex: 'createdAt',
      key: 'createdAt',
      title: t('credits.recharge.history.date'),
      render: (date: string) => formatDate(date),
      width: 180,
    },
    {
      dataIndex: 'type',
      key: 'type',
      title: 'Type',
      render: (type: string) => renderTypeTag(type),
      width: 100,
    },
    {
      dataIndex: 'amount',
      key: 'amount',
      title: t('credits.recharge.history.amount'),
      render: (amount: number) => formatAmount(amount),
      width: 100,
    },
    {
      dataIndex: 'balanceAfter',
      key: 'balanceAfter',
      title: t('credits.recharge.history.balanceAfter'),
      width: 120,
    },
  ];

  if (isLoadingProducts || isLoadingAccount || isLoadingHistory) {
    return (
      <Flexbox align="center" justify="center" style={{ padding: 48 }}>
        <Loader2 className="animate-spin" />
      </Flexbox>
    );
  }

  if (productsError || accountError) {
    return (
      <div className={styles.container}>
        <Empty description={t('credits.recharge.error')} />
      </div>
    );
  }

  const selectedProduct = creditProducts?.find((p: CreditProduct) => p.id === selectedPackage);

  return (
    <div className={styles.container}>
      <SettingHeader title={t('credits.recharge.title')} />

      {/* Balance Card */}
      <div className={styles.balanceCard}>
        <div className={styles.balanceTitle}>{t('credits.recharge.balance')}</div>
        <div className={styles.balanceValue}>{creditAccount?.balance ?? 0}</div>
      </div>

      {/* Recharge Packages */}
      <div className={styles.packagesSection}>
        <h3>{t('credits.recharge.selectPackage')}</h3>
        <div className={styles.packageGrid}>
          {creditProducts?.map((product: CreditProduct) => (
            <div
              key={product.id}
              className={styles.packageCard}
              data-selected={selectedPackage === product.id}
              onClick={() => handlePackageSelect(product.id)}
            >
              <div className={styles.packageHeader}>
                <span className={styles.packageTitle}>{t('credits.recharge.package')}</span>
                {selectedPackage === product.id && <CheckCircle2 size={16} color="#667eea" />}
              </div>
              <div className={styles.packageCredits}>{product.credits}</div>
              <div className={styles.packagePrice}>{formatPrice(product.priceCny)}</div>
            </div>
          ))}
        </div>

        <Flexbox justify="center" style={{ marginTop: 24 }}>
          <Button
            disabled={!selectedPackage}
            icon={<ExternalLink size={16} />}
            loading={isRecharging}
            onClick={handleRecharge}
            size="large"
            type="primary"
          >
            {t('credits.recharge.action')}
          </Button>
        </Flexbox>
      </div>

      {/* Recharge History */}
      <div className={styles.historySection}>
        <h3 className={styles.historyTitle}>{t('credits.recharge.history')}</h3>
        {ledgerEntries && ledgerEntries.length > 0 ? (
          <Table
            columns={historyColumns}
            dataSource={ledgerEntries}
            pagination={false}
            rowKey="id"
            size="small"
          />
        ) : (
          <Empty className={styles.empty} description={t('credits.recharge.history.empty')} />
        )}
      </div>

      {/* Confirm Modal */}
      <Modal
        onCancel={() => setConfirmModalOpen(false)}
        onOk={handleConfirmRecharge}
        open={confirmModalOpen}
        title={t('credits.recharge.confirmTitle')}
      >
        <p>
          {t('credits.recharge.confirmMessage', {
            credits: selectedProduct?.credits,
            price: selectedProduct ? selectedProduct.priceCny.toFixed(2) : '',
          })}
        </p>
      </Modal>
    </div>
  );
};

export default CreditRecharge;