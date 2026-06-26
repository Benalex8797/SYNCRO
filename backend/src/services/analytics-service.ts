import { supabase } from '../config/database';
import logger from '../config/logger';
import {
  buildCategoryMonthlySpend,
  buildPastMonthlySpendTrend,
  calculateMonthlySpend,
  countUpcomingRenewals,
  getTopMonthlySpendSubscriptions,
  normalizeToMonthlyAmount,
  roundMoney,
} from '@syncro/shared/subscription-math';
import { AnalyticsSummary, MonthlySpend, CategorySpend, SubscriptionSpend, Budget } from '../types/analytics';
import { Subscription } from '../types/reminder';

export class AnalyticsService {
  /**
   * Get analytics summary for a user
   */
  async getSummary(userId: string): Promise<AnalyticsSummary> {
    try {
      // 1. Fetch active subscriptions
      const { data: subscriptions, error: subError } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('user_id', userId)
        .eq('status', 'active');

      if (subError) throw subError;

      // 2. Fetch budgets
      const { data: budgets, error: budgetError } = await supabase
        .from('monthly_budgets')
        .select('*')
        .eq('user_id', userId);

      if (budgetError) throw budgetError;

      const typedSubs = (subscriptions || []) as Subscription[];
      const typedBudgets = (budgets || []) as Budget[];

      // 3. Calculate metrics
      const totalMonthlySpend = calculateMonthlySpend(typedSubs);
      const categoryBreakdown = this.formatCategoryBreakdown(typedSubs);
      const topSubscriptions = this.formatTopSubscriptions(typedSubs);
      const monthlyTrend = await this.getMonthlyTrend(userId, typedSubs);
      
      const overallBudget = typedBudgets.find(b => b.category === null);
      const budgetStatus = {
        overall_limit: overallBudget?.budget_limit || null,
        current_spend: totalMonthlySpend,
        percentage: overallBudget ? (totalMonthlySpend / overallBudget.budget_limit) * 100 : 0
      };

      const upcomingRenewalsCount = countUpcomingRenewals(typedSubs, 7);

      return {
        total_monthly_spend: totalMonthlySpend,
        active_subscriptions: typedSubs.length,
        upcoming_renewals_count: upcomingRenewalsCount,
        monthly_trend: monthlyTrend,
        category_breakdown: categoryBreakdown,
        top_subscriptions: topSubscriptions,
        budget_status: budgetStatus
      };
    } catch (error) {
      logger.error('Error fetching analytics summary:', error);
      throw error;
    }
  }

  private formatCategoryBreakdown(subscriptions: Subscription[]): CategorySpend[] {
    return buildCategoryMonthlySpend(subscriptions).map((category) => ({
      category: category.category,
      total_spend: category.totalMonthlySpend,
      percentage: category.percentage,
      count: category.count,
    }));
  }

  private formatTopSubscriptions(subscriptions: Subscription[]): SubscriptionSpend[] {
    return getTopMonthlySpendSubscriptions(subscriptions).map((subscription) => ({
      id: subscription.id ? String(subscription.id) : '',
      name: subscription.name ?? '',
      price: subscription.price,
      billing_cycle: subscription.billing_cycle,
      monthly_normalized_price: subscription.monthlyNormalizedPrice,
    }));
  }

  /**
   * Get monthly spend trend for the last 6 months
   */
  private async getMonthlyTrend(userId: string, currentSubs: Subscription[]): Promise<MonthlySpend[]> {
    // In a real app, this would query historical data or logs.
    // For now, we'll project the trend based on current subscriptions and created_at dates
    return buildPastMonthlySpendTrend(currentSubs).map((point) => ({
      month: point.month,
      total_spend: point.totalMonthlySpend,
      count: point.count,
    }));
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
    try {
      const summary = await this.getSummary(userId);
      const { budget_status } = summary;

      if (budget_status.overall_limit && budget_status.percentage >= 80) {
        // Trigger notification via riskNotificationService (reusing it or adding a new method)
        // For now, let's just insert an in-app notification directly
        const message = budget_status.percentage >= 100 
          ? `Urgent: You have exceeded your monthly budget of $${budget_status.overall_limit}!`
          : `Warning: You have used ${budget_status.percentage.toFixed(1)}% of your monthly budget.`;

        // Check if we already notified for this month to prevent spam
        const monthStr = new Date().toISOString().substring(0, 7);
        const { data: existing } = await supabase
          .from('notifications')
          .select('id')
          .eq('user_id', userId)
          .eq('type', 'budget_alert')
          .like('message', `%${monthStr}%`) // Simple deduplication for the month
          .limit(1);

        if (!existing || existing.length === 0) {
          await supabase.from('notifications').insert({
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
          });
          
          logger.info('Budget alert triggered', { userId, percentage: budget_status.percentage });
        }
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
      const monthlyTrend = await this.getMonthlyTrend(userId, typedSubs);
      const categoryBreakdown = this.formatCategoryBreakdown(typedSubs);

      return {
        current_month_spend: calculateMonthlySpend(typedSubs),
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

      const typedSubs = (subscriptions || []) as Subscription[];
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
            monthlyTotal += normalizeToMonthlyAmount(sub.price, sub.billing_cycle);
            count++;
          }
        }

        forecast.push({
          month: monthStr,
          total_spend: roundMoney(monthlyTotal),
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
