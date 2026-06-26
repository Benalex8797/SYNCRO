import swaggerJSDoc from 'swagger-jsdoc';
import type { OpenAPIV3 } from 'openapi-types';

const options: swaggerJSDoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'SYNCRO API',
      version: '1.0.0',
      description: 'Self-custodial subscription management platform API',
    },
    servers: [
      { url: 'http://localhost:3001', description: 'Development server' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Supabase JWT token via Authorization: Bearer <token>',
        },
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'authToken',
          description: 'HTTP-only cookie auth (alternative to Bearer)',
        },
        adminKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Admin-API-Key',
          description: 'Admin API key for protected admin endpoints',
        },
      },
      schemas: {
        SuccessResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: true },
          },
        },
        ProblemDetails: {
          type: 'object',
          properties: {
            type: { type: 'string', format: 'uri', example: 'https://syncro.app/errors/not-found' },
            title: { type: 'string', example: 'Not Found' },
            status: { type: 'integer', example: 404 },
            detail: { type: 'string', example: 'Subscription with ID 123 not found.' },
            instance: { type: 'string', example: '/api/v1/subscriptions/123' },
            requestId: { type: 'string', example: 'req-abc-123' },
            errors: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  field: { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
          },
        },
        ErrorResponse: {
          $ref: '#/components/schemas/ProblemDetails',
        },
        Pagination: {
          type: 'object',
          properties: {
            total: { type: 'integer' },
            limit: { type: 'integer' },
            offset: { type: 'integer' },
          },
        },
        Subscription: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            user_id: { type: 'string', format: 'uuid' },
            name: { type: 'string', example: 'Netflix' },
            price: { type: 'number', example: 15.99 },
            billing_cycle: { type: 'string', enum: ['monthly', 'yearly', 'quarterly'] },
            status: { type: 'string', enum: ['active', 'cancelled', 'expired'] },
            renewal_url: { type: 'string', format: 'uri', nullable: true },
            website_url: { type: 'string', format: 'uri', nullable: true },
            logo_url: { type: 'string', format: 'uri', nullable: true },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
        },
        BlockchainResult: {
          type: 'object',
          properties: {
            synced: { type: 'boolean' },
            transactionHash: { type: 'string', nullable: true },
            error: { type: 'string', nullable: true },
          },
        },
        RiskScore: {
          type: 'object',
          properties: {
            subscription_id: { type: 'string', format: 'uuid' },
            risk_level: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
            risk_factors: { type: 'array', items: { type: 'object' } },
            last_calculated_at: { type: 'string', format: 'date-time' },
          },
        },
        Merchant: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string' },
            category: { type: 'string', nullable: true },
            website_url: { type: 'string', format: 'uri', nullable: true },
            logo_url: { type: 'string', format: 'uri', nullable: true },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        TeamMember: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            userId: { type: 'string', format: 'uuid' },
            email: { type: 'string', format: 'email', nullable: true },
            role: { type: 'string', enum: ['admin', 'member', 'viewer'] },
            joinedAt: { type: 'string', format: 'date-time' },
          },
        },
        DigestPreferences: {
          type: 'object',
          properties: {
            digestEnabled: { type: 'boolean' },
            digestDay: { type: 'integer', minimum: 1, maximum: 28 },
            includeYearToDate: { type: 'boolean' },
          },
        },
        MonthlySpend: {
          type: 'object',
          properties: {
            month: { type: 'string', example: '2026-05', description: 'YYYY-MM' },
            total_spend: { type: 'number', example: 89.97 },
            count: { type: 'integer', example: 5 },
          },
        },
        CategorySpend: {
          type: 'object',
          properties: {
            category: { type: 'string', example: 'Entertainment' },
            total_spend: { type: 'number', example: 45.98 },
            percentage: { type: 'number', example: 51.1 },
            count: { type: 'integer', example: 3 },
          },
        },
        SubscriptionSpend: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            name: { type: 'string', example: 'Netflix' },
            price: { type: 'number', example: 15.99 },
            billing_cycle: { type: 'string', example: 'monthly' },
            monthly_normalized_price: { type: 'number', example: 15.99 },
          },
        },
      },
    },
  },
  apis: ['./src/routes/**/*.ts', './src/index.ts'],
};

export const swaggerSpec = swaggerJSDoc(options) as unknown as OpenAPIV3.Document;
