import { supabase } from '../config/database';
import logger from '../config/logger';
import { sendSlackAlert } from './slack-service';
import { calculateMonthlySpend } from '@syncro/shared/subscription-math';

function currentMonth(): string {
  return new Date().toISOString().substring(0, 7); // YYYY-MM
}

async function wasAlertSentThisMonth(userId: string, alertType: 'budget_warning' | 'budget_exceeded'): Promise<boolean> {
  const { data } = await supabase
    .from('budget_alert_logs')
    .select('id')
    .eq('user_id', userId)
    .eq('alert_type', alertType)
    .eq('month', currentMonth())
    .maybeSingle();
  return !!data;
}

async function recordAlert(userId: string, alertType: 'budget_warning' | 'budget_exceeded'): Promise<void> {
  await supabase.from('budget_alert_logs').upsert({
    user_id: userId,
    alert_type: alertType,
    month: currentMonth(),
  });
}

async function getTeamSlackWebhook(userId: string): Promise<string | null> {
  // Check if user owns a team or is a member
  const { data: ownedTeam } = await supabase
    .from('teams')
    .select('slack_webhook_url')
    .eq('owner_id', userId)
    .maybeSingle();

  if (ownedTeam?.slack_webhook_url) return ownedTeam.slack_webhook_url;

  const { data: membership } = await supabase
    .from('team_members')
    .select('team_id')
    .eq('user_id', userId)
    .maybeSingle();

  if (!membership) return null;

  const { data: team } = await supabase
    .from('teams')
    .select('slack_webhook_url')
    .eq('id', membership.team_id)
    .maybeSingle();

  return team?.slack_webhook_url ?? null;
}

export async function checkBudgetAlerts(userId: string): Promise<void> {
  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('monthly_budget, budget_alert_threshold')
      .eq('id', userId)
      .maybeSingle();

    if (!profile?.monthly_budget) return;

    const threshold = profile.budget_alert_threshold ?? 80;

    const { data: subs } = await supabase
      .from('subscriptions')
      .select('price, billing_cycle')
      .eq('user_id', userId)
      .eq('status', 'active');

    const monthlyTotal = calculateMonthlySpend(subs ?? []);

    const budget = Number(profile.monthly_budget);
    const percentage = (monthlyTotal / budget) * 100;

    let alertType: 'budget_warning' | 'budget_exceeded' | null = null;
    let message = '';

    if (percentage >= 100 && !(await wasAlertSentThisMonth(userId, 'budget_exceeded'))) {
      alertType = 'budget_exceeded';
      message = `🚨 You've exceeded your $${budget.toFixed(2)} monthly subscription budget by $${(monthlyTotal - budget).toFixed(2)}`;
    } else if (percentage >= threshold && !(await wasAlertSentThisMonth(userId, 'budget_warning'))) {
      alertType = 'budget_warning';
      message = `⚠️ You've used ${percentage.toFixed(0)}% of your $${budget.toFixed(2)} monthly subscription budget ($${monthlyTotal.toFixed(2)}/$${budget.toFixed(2)})`;
    }

    if (!alertType) return;

    // Insert in-app notification
    await supabase.from('notifications').insert({
      user_id: userId,
      type: alertType,
      message,
      metadata: { month: currentMonth(), percentage, limit: budget, current: monthlyTotal },
      read: false,
    });

    // Send Slack alert if team has a webhook configured
    const webhookUrl = await getTeamSlackWebhook(userId);
    if (webhookUrl) {
      await sendSlackAlert(webhookUrl, message);
    }

    await recordAlert(userId, alertType);
    logger.info('Budget alert sent', { userId, alertType, percentage });
  } catch (err) {
    logger.error('checkBudgetAlerts failed', { userId, err });
  }
}

/**
 * Returns how much adding a new subscription would push the monthly total,
 * and whether it would exceed the budget.
 */
export async function wouldExceedBudget(
  userId: string,
  newMonthlyAmount: number
): Promise<{ wouldExceed: boolean; newTotal: number; budget: number; overage: number } | null> {
  const { data: profile } = await supabase
    .from('profiles')
    .select('monthly_budget')
    .eq('id', userId)
    .maybeSingle();

  if (!profile?.monthly_budget) return null;

  const { data: subs } = await supabase
    .from('subscriptions')
    .select('price, billing_cycle')
    .eq('user_id', userId)
    .eq('status', 'active');

  const currentTotal = calculateMonthlySpend(subs ?? []);

  const budget = Number(profile.monthly_budget);
  const newTotal = currentTotal + newMonthlyAmount;

  return {
    wouldExceed: newTotal > budget,
    newTotal,
    budget,
    overage: Math.max(0, newTotal - budget),
  };
}
