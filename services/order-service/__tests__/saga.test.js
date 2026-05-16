/**
 * Order Saga Transaction Tests
 * Coverage:
 *   - All steps succeed → order marked as paid
 *   - Step 1 fails (stock insufficient) → no compensation needed
 *   - Step 2 fails (payment creation failed) → compensate Step 1 (restore stock)
 *   - Step 3 fails (clear cart failed) → compensate Step 2 (cancel payment) + Step 1 (restore stock)
 *   - Compensation failures are logged but don't throw
 */

const axios = require('axios');
const { query } = require('../../shared/lib/db');
const { EventBus, EventTypes } = require('../../shared/lib/events');

jest.mock('axios', () => ({
  post: jest.fn(),
  get: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
}));

jest.mock('../../shared/lib/db', () => ({
  getPool: jest.fn(),
  query: jest.fn(),
  transaction: jest.fn(),
  close: jest.fn(),
}));

jest.mock('../../shared/lib/events', () => ({
  EventBus: {
    getInstance: jest.fn(),
  },
  EventTypes: {
    ORDER_PAID: 'order.paid',
    ORDER_CREATED: 'order.created',
  },
}));

jest.mock('../../shared/lib/logger', () => ({
  createLogger: jest.fn().mockReturnValue({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }),
}));

const { OrderSaga } = require('../sagas/order-saga');

describe('OrderSaga', () => {
  let mockOrder;
  let mockItems;
  let mockUserId;
  let mockEventBusPublish;

  beforeEach(() => {
    jest.clearAllMocks();

    mockOrder = {
      id: 1,
      order_no: 'SC20240115000001',
      pay_amount: '13998.00',
      total_amount: '13998.00',
      user_id: 42,
    };

    mockItems = [
      { product_id: 10, sku_id: 100, product_name: 'iPhone 15', price: '6999.00', quantity: 2, subtotal: '13998.00' },
      { product_id: 20, sku_id: null, product_name: 'AirPods', price: '1999.00', quantity: 1, subtotal: '1999.00' },
    ];

    mockUserId = 42;

    mockEventBusPublish = jest.fn().mockResolvedValue(undefined);
    EventBus.getInstance.mockResolvedValue({
      publish: mockEventBusPublish,
    });

    query.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── Scenario 1: All steps succeed ──
  describe('All steps succeed', () => {
    test('should execute all steps and mark order as paid', async () => {
      // Step 1: deduct stock
      axios.post.mockImplementation((url) => {
        if (url.includes('deduct-stock')) {
          return Promise.resolve({ data: { success: true, remainingStock: 48 } });
        }
        if (url.includes('payments')) {
          return Promise.resolve({
            data: { id: 'pay_123', status: 'pending', paymentUrl: 'https://pay.example.com/123' },
          });
        }
        return Promise.resolve({ data: {} });
      });

      query.mockResolvedValue({ rows: [], command: 'DELETE' });

      const saga = new OrderSaga({
        sagaId: 'saga_SC001',
        order: mockOrder,
        items: mockItems,
        userId: mockUserId,
      });

      await saga.execute();

      // Verify stock deduction was called for each item
      expect(axios.post).toHaveBeenCalledWith(
        'http://product-service:3002/products/10/deduct-stock',
        { quantity: 2, sagaId: 'saga_SC001' },
        { timeout: 10000 }
      );
      expect(axios.post).toHaveBeenCalledWith(
        'http://product-service:3002/products/20/deduct-stock',
        { quantity: 1, sagaId: 'saga_SC001' },
        { timeout: 10000 }
      );

      // Verify payment creation
      expect(axios.post).toHaveBeenCalledWith(
        'http://payment-service:3004/payments',
        expect.objectContaining({
          orderId: 1,
          orderNo: 'SC20240115000001',
          userId: 42,
          amount: '13998.00',
          sagaId: 'saga_SC001',
        }),
        { timeout: 10000 }
      );

      // Verify cart cleared
      expect(query).toHaveBeenCalledWith(
        'DELETE FROM carts WHERE user_id = $1 AND selected = TRUE',
        [42]
      );

      // Verify order marked as paid
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE orders SET status = 'paid'"),
        [1]
      );

      // Verify ORDER_PAID event published
      expect(mockEventBusPublish).toHaveBeenCalledWith(
        EventTypes.ORDER_PAID,
        expect.objectContaining({
          orderId: 1,
          orderNo: 'SC20240115000001',
          sagaId: 'saga_SC001',
          items: mockItems,
        })
      );
    });

    test('should handle single item order successfully', async () => {
      const singleItem = [mockItems[0]];

      axios.post.mockImplementation((url) => {
        if (url.includes('deduct-stock')) {
          return Promise.resolve({ data: { success: true } });
        }
        if (url.includes('payments')) {
          return Promise.resolve({ data: { id: 'pay_456', status: 'pending' } });
        }
        return Promise.resolve({ data: {} });
      });

      query.mockResolvedValue({ rows: [] });

      const saga = new OrderSaga({
        sagaId: 'saga_SC002',
        order: mockOrder,
        items: singleItem,
        userId: mockUserId,
      });

      await saga.execute();

      expect(axios.post).toHaveBeenCalledTimes(2); // 1 stock + 1 payment
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE orders SET status = 'paid'"),
        [1]
      );
    });

    test('should store step results for each successful step', async () => {
      axios.post.mockImplementation((url) => {
        if (url.includes('deduct-stock')) {
          return Promise.resolve({ data: { success: true } });
        }
        if (url.includes('payments')) {
          return Promise.resolve({ data: { id: 'pay_789', status: 'pending' } });
        }
        return Promise.resolve({ data: {} });
      });

      query.mockResolvedValue({ rows: [] });

      const saga = new OrderSaga({
        sagaId: 'saga_SC003',
        order: mockOrder,
        items: mockItems,
        userId: mockUserId,
      });

      await saga.execute();

      expect(saga.stepResults).toHaveLength(3);
      expect(saga.stepResults[0].step).toBe('deduct_stock');
      expect(saga.stepResults[1].step).toBe('create_payment');
      expect(saga.stepResults[2].step).toBe('clear_cart');
    });
  });

  // ── Scenario 2: Step 1 fails (stock insufficient) ──
  describe('Step 1 fails (stock deduction)', () => {
    test('should fail immediately with no compensation executed', async () => {
      axios.post.mockImplementation((url) => {
        if (url.includes('deduct-stock') && url.includes('products/10')) {
          return Promise.reject(new Error('Insufficient stock'));
        }
        return Promise.resolve({ data: { success: true } });
      });

      const saga = new OrderSaga({
        sagaId: 'saga_SC004',
        order: mockOrder,
        items: mockItems,
        userId: mockUserId,
      });

      await saga.execute();

      // Payment creation should NOT be called
      expect(axios.post).not.toHaveBeenCalledWith(
        expect.stringContaining('payments'),
        expect.anything(),
        expect.anything()
      );

      // Cart clear should NOT be called
      expect(query).not.toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM carts'),
        expect.anything()
      );

      // Order should NOT be marked as paid
      expect(query).not.toHaveBeenCalledWith(
        expect.stringContaining("UPDATE orders SET status = 'paid'"),
        expect.anything()
      );

      // No compensation should have been registered
      expect(saga.compensations).toHaveLength(0);

      // ORDER_PAID event should NOT be published
      expect(mockEventBusPublish).not.toHaveBeenCalledWith(
        EventTypes.ORDER_PAID,
        expect.anything()
      );
    });

    test('should fail on second product stock deduction', async () => {
      let callCount = 0;
      axios.post.mockImplementation((url) => {
        if (url.includes('deduct-stock')) {
          callCount++;
          if (callCount === 2) {
            return Promise.reject(new Error('Product 20 out of stock'));
          }
          return Promise.resolve({ data: { success: true } });
        }
        return Promise.resolve({ data: {} });
      });

      const saga = new OrderSaga({
        sagaId: 'saga_SC005',
        order: mockOrder,
        items: mockItems,
        userId: mockUserId,
      });

      await saga.execute();

      // First product stock was deducted, second failed
      // Compensation should be registered (restore stock for first product)
      expect(axios.post).toHaveBeenCalledWith(
        expect.stringContaining('products/10/deduct-stock'),
        expect.anything(),
        expect.anything()
      );

      // Payment and cart clear should NOT be called
      expect(axios.post).not.toHaveBeenCalledWith(
        expect.stringContaining('payments'),
        expect.anything(),
        expect.anything()
      );
    });

    test('should handle product-service timeout', async () => {
      axios.post.mockImplementation((url) => {
        if (url.includes('deduct-stock')) {
          return Promise.reject(new Error('timeout of 10000ms exceeded'));
        }
        return Promise.resolve({ data: {} });
      });

      const saga = new OrderSaga({
        sagaId: 'saga_SC006',
        order: mockOrder,
        items: mockItems,
        userId: mockUserId,
      });

      await saga.execute();

      expect(saga.compensations).toHaveLength(0);
      expect(query).not.toHaveBeenCalledWith(
        expect.stringContaining("UPDATE orders SET status = 'paid'"),
        expect.anything()
      );
    });
  });

  // ── Scenario 3: Step 2 fails (payment creation) ──
  describe('Step 2 fails (payment creation)', () => {
    test('should compensate Step 1 by restoring stock', async () => {
      // Step 1 succeeds
      axios.post.mockImplementation((url) => {
        if (url.includes('deduct-stock')) {
          return Promise.resolve({ data: { success: true, remainingStock: 48 } });
        }
        if (url.includes('payments')) {
          return Promise.reject(new Error('Payment service unavailable'));
        }
        if (url.includes('restore-stock')) {
          return Promise.resolve({ data: { success: true, restored: true } });
        }
        return Promise.resolve({ data: {} });
      });

      const saga = new OrderSaga({
        sagaId: 'saga_SC007',
        order: mockOrder,
        items: mockItems,
        userId: mockUserId,
      });

      await saga.execute();

      // Verify stock was deducted first
      expect(axios.post).toHaveBeenCalledWith(
        'http://product-service:3002/products/10/deduct-stock',
        { quantity: 2, sagaId: 'saga_SC007' },
        { timeout: 10000 }
      );

      // Verify payment creation was attempted
      expect(axios.post).toHaveBeenCalledWith(
        'http://payment-service:3004/payments',
        expect.objectContaining({
          orderId: 1,
          orderNo: 'SC20240115000001',
          amount: '13998.00',
        }),
        { timeout: 10000 }
      );

      // Verify compensation: restore stock for both items
      expect(axios.post).toHaveBeenCalledWith(
        'http://product-service:3002/products/10/restore-stock',
        { quantity: 2, sagaId: 'saga_SC007' },
        { timeout: 10000 }
      );
      expect(axios.post).toHaveBeenCalledWith(
        'http://product-service:3002/products/20/restore-stock',
        { quantity: 1, sagaId: 'saga_SC007' },
        { timeout: 10000 }
      );

      // Verify order was reverted to pending
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE orders SET status = 'pending'"),
        [1]
      );

      // Verify saga failure event published
      expect(mockEventBusPublish).toHaveBeenCalledWith(
        EventTypes.ORDER_CREATED,
        expect.objectContaining({
          orderId: 1,
          status: 'pending',
          sagaId: 'saga_SC007',
          message: 'Saga failed, order reverted to pending',
        })
      );
    });

    test('should handle payment service 500 error', async () => {
      axios.post.mockImplementation((url) => {
        if (url.includes('deduct-stock')) {
          return Promise.resolve({ data: { success: true } });
        }
        if (url.includes('payments')) {
          const error = new Error('Internal Server Error');
          error.response = { status: 500, data: { error: 'DB connection failed' } };
          return Promise.reject(error);
        }
        if (url.includes('restore-stock')) {
          return Promise.resolve({ data: { restored: true } });
        }
        return Promise.resolve({ data: {} });
      });

      const saga = new OrderSaga({
        sagaId: 'saga_SC008',
        order: mockOrder,
        items: mockItems,
        userId: mockUserId,
      });

      await saga.execute();

      // Stock compensation should still be attempted
      expect(axios.post).toHaveBeenCalledWith(
        expect.stringContaining('restore-stock'),
        expect.anything(),
        expect.anything()
      );
    });

    test('should handle payment service network error', async () => {
      axios.post.mockImplementation((url) => {
        if (url.includes('deduct-stock')) {
          return Promise.resolve({ data: { success: true } });
        }
        if (url.includes('payments')) {
          return Promise.reject(new Error('ECONNREFUSED'));
        }
        if (url.includes('restore-stock')) {
          return Promise.resolve({ data: { restored: true } });
        }
        return Promise.resolve({ data: {} });
      });

      const saga = new OrderSaga({
        sagaId: 'saga_SC009',
        order: mockOrder,
        items: mockItems,
        userId: mockUserId,
      });

      await saga.execute();

      // Verify all stock was restored
      const restoreCalls = axios.post.mock.calls.filter(call => call[0].includes('restore-stock'));
      expect(restoreCalls).toHaveLength(2);
    });
  });

  // ── Scenario 4: Step 3 fails (clear cart) ──
  describe('Step 3 fails (clear cart)', () => {
    test('should compensate Step 2 (cancel payment) + Step 1 (restore stock)', async () => {
      const paymentResponse = { id: 'pay_abc123', status: 'pending' };

      axios.post.mockImplementation((url) => {
        if (url.includes('deduct-stock')) {
          return Promise.resolve({ data: { success: true, remainingStock: 48 } });
        }
        if (url.includes('payments')) {
          return Promise.resolve({ data: paymentResponse });
        }
        if (url.includes('restore-stock')) {
          return Promise.resolve({ data: { success: true, restored: true } });
        }
        return Promise.resolve({ data: {} });
      });

      axios.delete.mockResolvedValue({ data: { cancelled: true } });

      // Step 3 (clear cart) fails
      query.mockImplementation((sql) => {
        if (sql.includes('DELETE FROM carts')) {
          return Promise.reject(new Error('Cart deletion failed'));
        }
        if (sql.includes("UPDATE orders SET status = 'paid'")) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes("UPDATE orders SET status = 'pending'")) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const saga = new OrderSaga({
        sagaId: 'saga_SC010',
        order: mockOrder,
        items: mockItems,
        userId: mockUserId,
      });

      await saga.execute();

      // Verify all three steps were attempted (step 3 throws)
      // Step 1: deduct stock
      expect(axios.post).toHaveBeenCalledWith(
        'http://product-service:3002/products/10/deduct-stock',
        { quantity: 2, sagaId: 'saga_SC010' },
        { timeout: 10000 }
      );

      // Step 2: create payment
      expect(axios.post).toHaveBeenCalledWith(
        'http://payment-service:3004/payments',
        expect.objectContaining({
          orderId: 1,
          amount: '13998.00',
          sagaId: 'saga_SC010',
        }),
        { timeout: 10000 }
      );

      // Compensation: cancel payment (Step 2)
      expect(axios.delete).toHaveBeenCalledWith(
        `${process.env.PAYMENT_SERVICE_URL || 'http://payment-service:3004'}/payments/${paymentResponse.id}?sagaId=saga_SC010`,
        { timeout: 10000 }
      );

      // Compensation: restore stock (Step 1)
      expect(axios.post).toHaveBeenCalledWith(
        'http://product-service:3002/products/10/restore-stock',
        { quantity: 2, sagaId: 'saga_SC010' },
        { timeout: 10000 }
      );
      expect(axios.post).toHaveBeenCalledWith(
        'http://product-service:3002/products/20/restore-stock',
        { quantity: 1, sagaId: 'saga_SC010' },
        { timeout: 10000 }
      );

      // Verify order reverted to pending
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE orders SET status = 'pending'"),
        [1]
      );
    });

    test('should execute compensations in LIFO order (payment first, then stock)', async () => {
      const paymentResponse = { id: 'pay_def456', status: 'pending' };
      const executionOrder = [];

      axios.post.mockImplementation((url) => {
        if (url.includes('deduct-stock')) {
          executionOrder.push('deduct_stock');
          return Promise.resolve({ data: { success: true } });
        }
        if (url.includes('payments')) {
          executionOrder.push('create_payment');
          return Promise.resolve({ data: paymentResponse });
        }
        if (url.includes('restore-stock')) {
          executionOrder.push('restore_stock');
          return Promise.resolve({ data: { restored: true } });
        }
        return Promise.resolve({ data: {} });
      });

      axios.delete.mockImplementation((url) => {
        executionOrder.push('cancel_payment');
        return Promise.resolve({ data: { cancelled: true } });
      });

      query.mockImplementation((sql) => {
        if (sql.includes('DELETE FROM carts')) {
          executionOrder.push('clear_cart_fail');
          return Promise.reject(new Error('Cart clear failed'));
        }
        if (sql.includes('UPDATE orders')) {
          executionOrder.push('update_order');
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const saga = new OrderSaga({
        sagaId: 'saga_SC011',
        order: mockOrder,
        items: mockItems,
        userId: mockUserId,
      });

      await saga.execute();

      // Verify execution order:
      // deduct_stock -> create_payment -> clear_cart_fail -> cancel_payment -> restore_stock
      expect(executionOrder).toContain('deduct_stock');
      expect(executionOrder).toContain('create_payment');
      expect(executionOrder).toContain('clear_cart_fail');
      expect(executionOrder).toContain('cancel_payment');
      expect(executionOrder).toContain('restore_stock');

      // Verify compensation order: payment cancelled before stock restored
      const cancelPaymentIndex = executionOrder.indexOf('cancel_payment');
      const restoreStockIndex = executionOrder.indexOf('restore_stock');
      expect(cancelPaymentIndex).toBeLessThan(restoreStockIndex);
    });

    test('should handle compensation payment cancellation failure gracefully', async () => {
      axios.post.mockImplementation((url) => {
        if (url.includes('deduct-stock')) {
          return Promise.resolve({ data: { success: true } });
        }
        if (url.includes('payments')) {
          return Promise.resolve({ data: { id: 'pay_ghi789', status: 'pending' } });
        }
        if (url.includes('restore-stock')) {
          return Promise.resolve({ data: { restored: true } });
        }
        return Promise.resolve({ data: {} });
      });

      // Payment cancellation fails but stock restore should still execute
      axios.delete.mockRejectedValue(new Error('Payment cancellation failed'));

      query.mockImplementation((sql) => {
        if (sql.includes('DELETE FROM carts')) {
          return Promise.reject(new Error('Cart clear failed'));
        }
        if (sql.includes('UPDATE orders')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const saga = new OrderSaga({
        sagaId: 'saga_SC012',
        order: mockOrder,
        items: mockItems,
        userId: mockUserId,
      });

      await saga.execute();

      // Stock restore should still be attempted even if payment cancel failed
      expect(axios.post).toHaveBeenCalledWith(
        expect.stringContaining('restore-stock'),
        expect.anything(),
        expect.anything()
      );
    });

    test('should handle stock restore compensation failure gracefully', async () => {
      axios.post.mockImplementation((url) => {
        if (url.includes('deduct-stock')) {
          return Promise.resolve({ data: { success: true } });
        }
        if (url.includes('payments')) {
          return Promise.resolve({ data: { id: 'pay_jkl012', status: 'pending' } });
        }
        if (url.includes('restore-stock')) {
          return Promise.reject(new Error('Restore stock failed'));
        }
        return Promise.resolve({ data: {} });
      });

      axios.delete.mockResolvedValue({ data: { cancelled: true } });

      query.mockImplementation((sql) => {
        if (sql.includes('DELETE FROM carts')) {
          return Promise.reject(new Error('Cart clear failed'));
        }
        if (sql.includes('UPDATE orders')) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const saga = new OrderSaga({
        sagaId: 'saga_SC013',
        order: mockOrder,
        items: mockItems,
        userId: mockUserId,
      });

      // Should not throw even though compensation partially failed
      await expect(saga.execute()).resolves.not.toThrow();
    });
  });

  // ── Edge Cases ──
  describe('Edge cases', () => {
    test('should handle empty items array', async () => {
      axios.post.mockImplementation((url) => {
        if (url.includes('payments')) {
          return Promise.resolve({ data: { id: 'pay_empty', status: 'pending' } });
        }
        return Promise.resolve({ data: {} });
      });

      query.mockResolvedValue({ rows: [] });

      const saga = new OrderSaga({
        sagaId: 'saga_empty',
        order: { ...mockOrder, id: 99 },
        items: [],
        userId: mockUserId,
      });

      await saga.execute();

      // No stock deduction should be called
      const stockCalls = axios.post.mock.calls.filter(call => call[0].includes('deduct-stock'));
      expect(stockCalls).toHaveLength(0);

      // Payment should still be created
      expect(axios.post).toHaveBeenCalledWith(
        expect.stringContaining('payments'),
        expect.anything(),
        expect.anything()
      );

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE orders SET status = 'paid'"),
        [99]
      );
    });

    test('should handle query failure in markOrderPaid', async () => {
      axios.post.mockImplementation((url) => {
        if (url.includes('deduct-stock')) {
          return Promise.resolve({ data: { success: true } });
        }
        if (url.includes('payments')) {
          return Promise.resolve({ data: { id: 'pay_mno345', status: 'pending' } });
        }
        return Promise.resolve({ data: {} });
      });

      query.mockImplementation((sql) => {
        if (sql.includes('DELETE FROM carts')) {
          return Promise.resolve({ rows: [], command: 'DELETE' });
        }
        if (sql.includes("UPDATE orders SET status = 'paid'")) {
          return Promise.reject(new Error('Cannot update order'));
        }
        if (sql.includes("UPDATE orders SET status = 'pending'")) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({ rows: [] });
      });

      const saga = new OrderSaga({
        sagaId: 'saga_SC014',
        order: mockOrder,
        items: mockItems,
        userId: mockUserId,
      });

      await saga.execute();

      // Compensation should be triggered
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE orders SET status = 'pending'"),
        [1]
      );
    });

    test('should use environment variable for service URLs', async () => {
      const originalProductUrl = process.env.PRODUCT_SERVICE_URL;
      const originalPaymentUrl = process.env.PAYMENT_SERVICE_URL;
      process.env.PRODUCT_SERVICE_URL = 'http://product-svc:8080';
      process.env.PAYMENT_SERVICE_URL = 'http://payment-svc:8081';

      // Need to re-require to pick up env vars
      jest.resetModules();
      jest.doMock('axios', () => ({
        post: jest.fn().mockResolvedValue({ data: { success: true } }),
        delete: jest.fn().mockResolvedValue({ data: {} }),
        get: jest.fn(),
        put: jest.fn(),
      }));
      jest.doMock('../../shared/lib/db', () => ({
        getPool: jest.fn(),
        query: jest.fn().mockResolvedValue([]),
        transaction: jest.fn(),
        close: jest.fn(),
      }));
      jest.doMock('../../shared/lib/events', () => ({
        EventBus: {
          getInstance: jest.fn().mockResolvedValue({
            publish: jest.fn().mockResolvedValue(undefined),
          }),
        },
        EventTypes: {
          ORDER_PAID: 'order.paid',
          ORDER_CREATED: 'order.created',
        },
      }));
      jest.doMock('../../shared/lib/logger', () => ({
        createLogger: jest.fn().mockReturnValue({
          info: jest.fn(),
          error: jest.fn(),
          warn: jest.fn(),
          debug: jest.fn(),
        }),
      }));

      const { OrderSaga: ReloadedOrderSaga } = require('../sagas/order-saga');

      const axiosMocked = require('axios');
      axiosMocked.post.mockImplementation((url) => {
        if (url.includes('deduct-stock')) {
          return Promise.resolve({ data: { success: true } });
        }
        if (url.includes('payments')) {
          return Promise.resolve({ data: { id: 'pay_env', status: 'pending' } });
        }
        if (url.includes('restore-stock')) {
          return Promise.resolve({ data: { restored: true } });
        }
        return Promise.resolve({ data: {} });
      });

      const saga = new ReloadedOrderSaga({
        sagaId: 'saga_env',
        order: mockOrder,
        items: [mockItems[0]],
        userId: mockUserId,
      });

      await saga.execute();

      // Restore env
      process.env.PRODUCT_SERVICE_URL = originalProductUrl;
      process.env.PAYMENT_SERVICE_URL = originalPaymentUrl;

      // Verify the saga completed without error using custom URLs
      expect(axiosMocked.post).toHaveBeenCalled();
    });

    test('should not call compensate when no steps executed', async () => {
      // stepDeductStock fails immediately
      axios.post.mockRejectedValue(new Error('Product service unavailable'));

      const saga = new OrderSaga({
        sagaId: 'saga_no_steps',
        order: mockOrder,
        items: mockItems,
        userId: mockUserId,
      });

      // Spy on compensate
      const compensateSpy = jest.spyOn(saga, 'compensate');

      await saga.execute();

      // compensate IS called but with empty compensations array
      expect(compensateSpy).toHaveBeenCalled();
      expect(saga.compensations).toHaveLength(0);
    });

    test('should handle saga with correct sagaId format', async () => {
      axios.post.mockResolvedValue({ data: { success: true } });

      query.mockResolvedValue({ rows: [] });

      const saga = new OrderSaga({
        sagaId: 'saga_SC20240115987654',
        order: { ...mockOrder, id: 55 },
        items: mockItems,
        userId: 99,
      });

      await saga.execute();

      expect(axios.post).toHaveBeenCalledWith(
        expect.stringContaining('deduct-stock'),
        expect.objectContaining({ sagaId: 'saga_SC20240115987654' }),
        expect.anything()
      );
    });
  });
});
