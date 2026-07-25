import { supabase } from '../config/database';
import logger from '../config/logger';
import { AnalyticsSummary, MonthlySpend, CategorySpend, SubscriptionSpend, Budget } from '../types/analytics';
import { Subscription } from '../types/reminder';
import { groupBy, uniqueIds } from '../utils/db-query-metrics';

/**
 * Subscriptions as read by this service. `cancelled_at` is only present on rows
 * that have been cancelled, so it is modelled as optional here rather than on
 * the shared `Subscription` type.
 */
type AnalyticsSubscription = Subscription & { cancelled_at?: string | null };

export class AnalyticsService {
  /**
   * Get analytics summary for a user
   */
  async getSummary(userId: string): Promise<AnalyticsSummary> {
    const summaries = await this.getSummaries([userId]);
    return summaries.get(userId) ?? this.composeSummary([], []);
  }

  /**
   * Get analytics summaries for many users in a fixed number of queries
   * (issue #1095).
   *
   * The per-user path costs two queries, so composing summaries for N users in
   * a loop cost 2N. This issues one subscriptions query and one budgets query
   * for the whole set and fans the rows out in memory.
   */
  async getSummaries(userIds: readonly string[]): Promise<Map<string, AnalyticsSummary>> {
    const summaries = new Map<string, AnalyticsSummary>();
    const ids = uniqueIds(userIds);
    if (ids.length === 0) return summaries;

    try {
      const [subsRes, budgetsRes] = await Promise.all([
        supabase.from('subscriptions').select('*').in('user_id', ids).eq('status', 'active'),
        supabase.from('monthly_budgets').select('*').in('user_id', ids),
      ]);

      if (subsRes.error) throw subsRes.error;
      if (budgetsRes.error) throw budgetsRes.error;

      const subsByUser = groupBy(
        (subsRes.data || []) as AnalyticsSubscription[],
        (sub) => sub.user_id,
      );
      const budgetsByUser = groupBy((budgetsRes.data || []) as Budget[], (b) => b.user_id);

      for (const userId of ids) {
        summaries.set(
          userId,
          this.composeSummary(subsByUser.get(userId) ?? [], budgetsByUser.get(userId) ?? []),
        );
      }

      return summaries;
    } catch (error) {
      logger.error('Error fetching analytics summary:', error);
      throw error;
    }
  }

  /**
   * Turn one user's subscription and budget rows into a summary. Pure — all DB
   * access happens in `getSummaries`.
   */
  private composeSummary(
    subscriptions: AnalyticsSubscription[],
    budgets: Budget[],
  ): AnalyticsSummary {
    const totalMonthlySpend = this.calculateTotalMonthlySpend(subscriptions);
    const categoryBreakdown = this.calculateCategoryBreakdown(subscriptions, totalMonthlySpend);
    const topSubscriptions = this.getTopSubscriptions(subscriptions);
    const monthlyTrend = this.getMonthlyTrend(subscriptions);

    const overallBudget = budgets.find(b => b.category === null);
    const budgetStatus = {
      overall_limit: overallBudget?.budget_limit || null,
      current_spend: totalMonthlySpend,
      percentage: overallBudget ? (totalMonthlySpend / overallBudget.budget_limit) * 100 : 0
    };

    // Upcoming renewals count (next 7 days)
    const next7Days = new Date();
    next7Days.setDate(next7Days.getDate() + 7);
    const upcomingRenewalsCount = subscriptions.filter(sub => {
      if (!sub.next_billing_date) return false;
      const renewalDate = new Date(sub.next_billing_date);
      return renewalDate <= next7Days && renewalDate >= new Date();
    }).length;

    return {
      total_monthly_spend: totalMonthlySpend,
      active_subscriptions: subscriptions.length,
      upcoming_renewals_count: upcomingRenewalsCount,
      monthly_trend: monthlyTrend,
      category_breakdown: categoryBreakdown,
      top_subscriptions: topSubscriptions,
      budget_status: budgetStatus
    };
  }

  /**
   * Calculate monthly normalized spend
   */
  private calculateTotalMonthlySpend(subscriptions: Subscription[]): number {
    return subscriptions.reduce((total, sub) => {
      return total + this.normalizeToMonthly(sub.price, sub.billing_cycle);
    }, 0);
  }

  /**
   * Normalize price to monthly
   */
  private normalizeToMonthly(price: number, cycle: string): number {
    switch (cycle.toLowerCase()) {
      case 'annual':
      case 'yearly':
        return price / 12;
      case 'monthly':
        return price;
      case 'weekly':
        return price * (365 / 7 / 12); // Average weeks in a month
      case 'quarterly':
        return price / 3;
      case 'semiannual':
        return price / 6;
      default:
        return price;
    }
  }

  /**
   * Calculate spend by category
   */
  private calculateCategoryBreakdown(subscriptions: Subscription[], totalSpend: number): CategorySpend[] {
    const categories: Record<string, { total: number, count: number }> = {};
    
    subscriptions.forEach(sub => {
      const category = sub.category || 'Other';
      if (!categories[category]) {
        categories[category] = { total: 0, count: 0 };
      }
      categories[category].total += this.normalizeToMonthly(sub.price, sub.billing_cycle);
      categories[category].count += 1;
    });

    return Object.entries(categories).map(([name, data]) => ({
      category: name,
      total_spend: parseFloat(data.total.toFixed(2)),
      percentage: totalSpend > 0 ? (data.total / totalSpend) * 100 : 0,
      count: data.count
    })).sort((a, b) => b.total_spend - a.total_spend);
  }

  /**
   * Get top 5 expensive subscriptions (monthly normalized)
   */
  private getTopSubscriptions(subscriptions: Subscription[]): SubscriptionSpend[] {
    return subscriptions.map(sub => ({
      id: sub.id,
      name: sub.name,
      price: sub.price,
      billing_cycle: sub.billing_cycle,
      monthly_normalized_price: this.normalizeToMonthly(sub.price, sub.billing_cycle)
    }))
    .sort((a, b) => b.monthly_normalized_price - a.monthly_normalized_price)
    .slice(0, 5);
  }

  /**
   * Get monthly spend trend for the last 6 months.
   *
   * Projected from the subscription rows the caller already holds — it never
   * touched the database, so it no longer takes a userId or returns a promise.
   */
  private getMonthlyTrend(currentSubs: Subscription[]): MonthlySpend[] {
    // In a real app, this would query historical data or logs.
    // For now, we'll project the trend based on current subscriptions and created_at dates
    const trend: MonthlySpend[] = [];
    const now = new Date();
    
    for (let i = 5; i >= 0; i--) {
      const targetDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthStr = targetDate.toISOString().substring(0, 7);
      
      // Filter subs that existed in this month
      const subsAtTime = currentSubs.filter(sub => {
        const createdAt = new Date(sub.created_at);
        return createdAt <= new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 0);
      });

      const monthlyTotal = subsAtTime.reduce((total, sub) => {
        return total + this.normalizeToMonthly(sub.price, sub.billing_cycle);
      }, 0);

      trend.push({
        month: monthStr,
        total_spend: parseFloat(monthlyTotal.toFixed(2)),
        count: subsAtTime.length
      });
    }

    return trend;
  }

  /**
   * Get user budgets
   */
  async getUserBudgets(userId: string) {
    return await supabase
      .from('monthly_budgets')
      .select('*')
      .eq('user_id', userId);
  }

  /**
   * Upsert a budget
   */
  async upsertBudget(userId: string, budget: Partial<Budget>) {
    const { data, error } = await supabase
      .from('monthly_budgets')
      .upsert({
        ...budget,
        user_id: userId,
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      logger.error('Error upserting budget:', error);
      throw error;
    }

    return data;
  }

  /**
   * Check if user has exceeded their budget and notify if necessary
   */
  async checkBudgetThreshold(userId: string): Promise<void> {
    return this.checkBudgetThresholds([userId]);
  }

  /**
   * Check budget thresholds for many users and raise any needed alerts
   * (issue #1095).
   *
   * Costs four queries for the whole set — two for the summaries, one
   * de-duplication read and one batched notification insert — instead of the
   * three-per-user the single-user path needed.
   */
  async checkBudgetThresholds(userIds: readonly string[]): Promise<void> {
    const ids = uniqueIds(userIds);
    if (ids.length === 0) return;

    try {
      const summaries = await this.getSummaries(ids);
      const monthStr = new Date().toISOString().substring(0, 7);

      // Users at or over the alert threshold.
      const breached = ids
        .map((userId) => ({ userId, summary: summaries.get(userId) }))
        .filter((entry): entry is { userId: string; summary: AnalyticsSummary } =>
          !!entry.summary &&
          !!entry.summary.budget_status.overall_limit &&
          entry.summary.budget_status.percentage >= 80,
        );

      if (breached.length === 0) return;

      // Check which users were already notified this month, to prevent spam.
      const { data: existing } = await supabase
        .from('notifications')
        .select('user_id')
        .in('user_id', breached.map((entry) => entry.userId))
        .eq('type', 'budget_alert')
        .like('message', `%${monthStr}%`); // Simple deduplication for the month

      const alreadyNotified = new Set(
        ((existing ?? []) as { user_id: string }[]).map((row) => row.user_id),
      );

      const notifications = breached
        .filter((entry) => !alreadyNotified.has(entry.userId))
        .map(({ userId, summary }) => {
          const { budget_status } = summary;
          const message = budget_status.percentage >= 100
            ? `Urgent: You have exceeded your monthly budget of $${budget_status.overall_limit}!`
            : `Warning: You have used ${budget_status.percentage.toFixed(1)}% of your monthly budget.`;

          logger.info('Budget alert triggered', { userId, percentage: budget_status.percentage });

          return {
            user_id: userId,
            type: 'budget_alert',
            message: `${message} (Current spend: $${budget_status.current_spend.toFixed(2)})`,
            metadata: {
              month: monthStr,
              percentage: budget_status.percentage,
              limit: budget_status.overall_limit
            },
            read: false,
            created_at: new Date().toISOString()
          };
        });

      if (notifications.length > 0) {
        await supabase.from('notifications').insert(notifications);
      }
    } catch (error) {
      logger.error('Error checking budget threshold:', error);
    }
  }

  /**
   * Get spending trends for the user
   */
  async getSpending(userId: string) {
    try {
      const { data: subscriptions, error: subError } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('user_id', userId);

      if (subError) throw subError;

      const typedSubs = (subscriptions || []) as Subscription[];
      const monthlyTrend = this.getMonthlyTrend(typedSubs);
      const categoryBreakdown = this.calculateCategoryBreakdown(typedSubs, this.calculateTotalMonthlySpend(typedSubs));

      return {
        current_month_spend: this.calculateTotalMonthlySpend(typedSubs),
        monthly_trend: monthlyTrend,
        category_breakdown: categoryBreakdown,
        active_subscriptions: typedSubs.length
      };
    } catch (error) {
      logger.error('Error fetching spending data:', error);
      throw error;
    }
  }

  /**
   * Get spending forecast for the next 6 months
   */
  async getForecast(userId: string) {
    try {
      const { data: subscriptions, error: subError } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('user_id', userId)
        .eq('status', 'active');

      if (subError) throw subError;

      const typedSubs = (subscriptions || []) as AnalyticsSubscription[];
      const forecast: MonthlySpend[] = [];
      const now = new Date();

      // Generate forecast for next 6 months
      for (let i = 0; i < 6; i++) {
        const targetDate = new Date(now.getFullYear(), now.getMonth() + i, 1);
        const monthStr = targetDate.toISOString().substring(0, 7);
        
        let monthlyTotal = 0;
        let count = 0;

        // Calculate spend for each active subscription in this month
        for (const sub of typedSubs) {
          const createdAt = new Date(sub.created_at);
          const nextBillingDate = sub.next_billing_date ? new Date(sub.next_billing_date) : createdAt;
          
          // Check if subscription will be active in this month
          if (createdAt <= new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 0)) {
            // Check if the subscription isn't cancelled or will be cancelled before this month
            if (!sub.cancelled_at || new Date(sub.cancelled_at) > new Date(targetDate.getFullYear(), targetDate.getMonth(), 1)) {
              monthlyTotal += this.normalizeToMonthly(sub.price, sub.billing_cycle);
              count++;
            }
          }
        }

        forecast.push({
          month: monthStr,
          total_spend: parseFloat(monthlyTotal.toFixed(2)),
          count: count
        });
      }

      return {
        forecast,
        avg_projected_monthly_spend: parseFloat((forecast.reduce((sum, m) => sum + m.total_spend, 0) / forecast.length).toFixed(2))
      };
    } catch (error) {
      logger.error('Error fetching forecast data:', error);
      throw error;
    }
  }
}

export const analyticsService = new AnalyticsService();
