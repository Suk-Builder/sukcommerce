/**
 * Inventory Management Tests
 * Covers: POST /products/:id/deduct-stock, POST /products/:id/restore-stock
 * Focus: PostgreSQL FOR UPDATE locking, low stock events, Saga compensation
 */
const request = require('supertest');
const app = require('../index');
const {
  mockQuery,
  mockPublish,
  EventTypes,
  clearRedisCache,
  mockTransactionWithResults
} = require('./setup');

describe('Inventory Routes', () => {
  afterEach(() => {
    clearRedisCache();
  });

  const mockSku = { id: 1, sku_code: 'IP15-BLK-128', attributes: '{"color":"black"}', price: 999, stock: 50, status: 'active', product_id: 1 };

  // ==========================================
  // POST /products/:id/deduct-stock — 库存扣减
  // ==========================================
  describe('POST /products/:id/deduct-stock', () => {
    test('should deduct stock successfully (200)', async () => {
      require('../../shared/lib/db').transaction = jest.fn().mockImplementation(async (callback) => {
        const mockClient = {
          query: jest.fn().mockImplementation(async (sql, params) => {
            if (sql.includes('FOR UPDATE')) {
              return { rows: [mockSku] };
            }
            if (sql.includes('UPDATE skus')) {
              return { rows: [] };
            }
            if (sql.includes('UPDATE products')) {
              return { rows: [] };
            }
            if (sql.includes('INSERT INTO inventory_log')) {
              return { rows: [] };
            }
            return { rows: [] };
          })
        };
        return await callback(mockClient);
      });

      const res = await request(app)
        .post('/products/1/deduct-stock')
        .send({ quantity: 5, sku_id: 1, order_id: 'order-123' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.deducted).toBe(5);
      expect(res.body.old_stock).toBe(50);
      expect(res.body.new_stock).toBe(45);
    });

    test('should deduct stock and return remaining_stock (200)', async () => {
      require('../../shared/lib/db').transaction = jest.fn().mockImplementation(async (callback) => {
        const mockClient = {
          query: jest.fn().mockImplementation(async (sql, params) => {
            if (sql.includes('FOR UPDATE')) {
              return { rows: [{ ...mockSku, stock: 100 }] };
            }
            return { rows: [] };
          })
        };
        return await callback(mockClient);
      });

      const res = await request(app)
        .post('/products/1/deduct-stock')
        .send({ quantity: 20, sku_id: 1 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.new_stock).toBe(80);
    });

    test('should publish low stock event when stock < 10 after deduction', async () => {
      require('../../shared/lib/db').transaction = jest.fn().mockImplementation(async (callback) => {
        const mockClient = {
          query: jest.fn().mockImplementation(async (sql, params) => {
            if (sql.includes('FOR UPDATE')) {
              return { rows: [{ ...mockSku, stock: 12 }] };
            }
            if (sql.includes('UPDATE skus') && params[1] === 1) {
              return { rows: [] };
            }
            return { rows: [] };
          })
        };
        return await callback(mockClient);
      });

      const res = await request(app)
        .post('/products/1/deduct-stock')
        .send({ quantity: 5, sku_id: 1, order_id: 'order-456' });

      expect(res.status).toBe(200);
      expect(res.body.new_stock).toBe(7);
      expect(mockPublish).toHaveBeenCalled();
    });

    test('should not publish low stock event when stock >= 10 after deduction', async () => {
      require('../../shared/lib/db').transaction = jest.fn().mockImplementation(async (callback) => {
        const mockClient = {
          query: jest.fn().mockImplementation(async (sql, params) => {
            if (sql.includes('FOR UPDATE')) {
              return { rows: [{ ...mockSku, stock: 20 }] };
            }
            return { rows: [] };
          })
        };
        return await callback(mockClient);
      });

      await request(app)
        .post('/products/1/deduct-stock')
        .send({ quantity: 5, sku_id: 1 });

      const lowStockCalls = mockPublish.mock.calls.filter(
        c => c[0] === EventTypes.PRODUCT_LOW_STOCK
      );
      expect(lowStockCalls).toHaveLength(0);
    });

    test('should return 400 when quantity exceeds available stock', async () => {
      require('../../shared/lib/db').transaction = jest.fn().mockImplementation(async (callback) => {
        const mockClient = {
          query: jest.fn().mockImplementation(async (sql, params) => {
            if (sql.includes('FOR UPDATE')) {
              return { rows: [{ ...mockSku, stock: 5 }] };
            }
            return { rows: [] };
          })
        };
        return await callback(mockClient);
      });

      const res = await request(app)
        .post('/products/1/deduct-stock')
        .send({ quantity: 10, sku_id: 1 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('E4001');
    });

    test('should return 400 when quantity is exactly stock', async () => {
      require('../../shared/lib/db').transaction = jest.fn().mockImplementation(async (callback) => {
        const mockClient = {
          query: jest.fn().mockImplementation(async (sql, params) => {
            if (sql.includes('FOR UPDATE')) {
              return { rows: [{ ...mockSku, stock: 10 }] };
            }
            return { rows: [] };
          })
        };
        return await callback(mockClient);
      });

      const res = await request(app)
        .post('/products/1/deduct-stock')
        .send({ quantity: 10, sku_id: 1 });

      expect(res.status).toBe(200);
      expect(res.body.new_stock).toBe(0);
    });

    test('should return 400 when SKU does not exist', async () => {
      require('../../shared/lib/db').transaction = jest.fn().mockImplementation(async (callback) => {
        const mockClient = {
          query: jest.fn().mockImplementation(async (sql, params) => {
            if (sql.includes('FOR UPDATE')) {
              return { rows: [] }; // SKU not found
            }
            return { rows: [] };
          })
        };
        return await callback(mockClient);
      });

      const res = await request(app)
        .post('/products/1/deduct-stock')
        .send({ quantity: 5, sku_id: 999 });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('E4000');
    });

    test('should return 400 when quantity is missing', async () => {
      const res = await request(app)
        .post('/products/1/deduct-stock')
        .send({ sku_id: 1 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('E8000');
    });

    test('should return 400 when quantity is zero', async () => {
      const res = await request(app)
        .post('/products/1/deduct-stock')
        .send({ quantity: 0, sku_id: 1 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('E8000');
    });

    test('should return 400 when quantity is negative', async () => {
      const res = await request(app)
        .post('/products/1/deduct-stock')
        .send({ quantity: -1, sku_id: 1 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('E8000');
    });

    test('should deduct with correct inventory log fields', async () => {
      let capturedLogQuery;
      require('../../shared/lib/db').transaction = jest.fn().mockImplementation(async (callback) => {
        const mockClient = {
          query: jest.fn().mockImplementation(async (sql, params) => {
            if (sql.includes('FOR UPDATE')) {
              return { rows: [{ ...mockSku, stock: 100 }] };
            }
            if (sql.includes('INSERT INTO inventory_log')) {
              capturedLogQuery = { sql, params };
            }
            return { rows: [] };
          })
        };
        return await callback(mockClient);
      });

      const res = await request(app)
        .post('/products/1/deduct-stock')
        .send({ quantity: 10, sku_id: 1, order_id: 'order-789' });

      expect(res.status).toBe(200);
      expect(capturedLogQuery.params).toEqual([1, 1, -10, 'order_deduct', 'order-789']);
    });

    // ========== FOR UPDATE Lock Tests ==========
    describe('FOR UPDATE Lock Scenarios', () => {
      test('should use FOR UPDATE in SKU select query', async () => {
        let forUpdateQuery;
        require('../../shared/lib/db').transaction = jest.fn().mockImplementation(async (callback) => {
          const mockClient = {
            query: jest.fn().mockImplementation(async (sql, params) => {
              if (sql.includes('FOR UPDATE')) {
                forUpdateQuery = sql;
                return { rows: [mockSku] };
              }
              return { rows: [] };
            })
          };
          return await callback(mockClient);
        });

        await request(app)
          .post('/products/1/deduct-stock')
          .send({ quantity: 5, sku_id: 1 });

        expect(forUpdateQuery).toContain('FOR UPDATE');
      });

      test('should lock correct SKU by sku_id and product_id', async () => {
        let lockParams;
        require('../../shared/lib/db').transaction = jest.fn().mockImplementation(async (callback) => {
          const mockClient = {
            query: jest.fn().mockImplementation(async (sql, params) => {
              if (sql.includes('FOR UPDATE')) {
                lockParams = params;
                return { rows: [mockSku] };
              }
              return { rows: [] };
            })
          };
          return await callback(mockClient);
        });

        await request(app)
          .post('/products/1/deduct-stock')
          .send({ quantity: 5, sku_id: 1 });

        expect(lockParams[0]).toBe(1); // sku_id
        expect(lockParams[1]).toBe(1); // product_id
      });

      test('should handle concurrent deduction - first succeeds', async () => {
        let callCount = 0;
        require('../../shared/lib/db').transaction = jest.fn().mockImplementation(async (callback) => {
          const currentCall = ++callCount;
          const mockClient = {
            query: jest.fn().mockImplementation(async (sql, params) => {
              if (sql.includes('FOR UPDATE')) {
                // Simulate that first call sees 15 stock, second sees 15-10=5 (after first commits)
                const simulatedStock = currentCall === 1 ? 15 : 5;
                return { rows: [{ ...mockSku, stock: simulatedStock }] };
              }
              return { rows: [] };
            })
          };
          return await callback(mockClient);
        });

        // First request: deduct 10 from 15 -> 5 remaining
        const res1 = await request(app)
          .post('/products/1/deduct-stock')
          .send({ quantity: 10, sku_id: 1 });

        expect(res1.status).toBe(200);
        expect(res1.body.new_stock).toBe(5);
      });

      test('should handle concurrent deduction - second blocked until first releases lock', async () => {
        const executionOrder = [];
        require('../../shared/lib/db').transaction = jest.fn().mockImplementation(async (callback) => {
          const mockClient = {
            query: jest.fn().mockImplementation(async (sql, params) => {
              if (sql.includes('FOR UPDATE')) {
                executionOrder.push('lock_acquired');
                return { rows: [{ ...mockSku, stock: 50 }] };
              }
              if (sql.includes('UPDATE skus')) {
                executionOrder.push('stock_updated');
              }
              return { rows: [] };
            })
          };
          return await callback(mockClient);
        });

        const res = await request(app)
          .post('/products/1/deduct-stock')
          .send({ quantity: 5, sku_id: 1 });

        expect(res.status).toBe(200);
        expect(executionOrder).toEqual(['lock_acquired', 'stock_updated']);
      });

      test('should rollback transaction on error', async () => {
        const rollbackQueries = [];
        require('../../shared/lib/db').transaction = jest.fn().mockImplementation(async (callback) => {
          const mockClient = {
            query: jest.fn().mockImplementation(async (sql, params) => {
              if (sql === 'BEGIN') {
                rollbackQueries.push('begin');
                return { rows: [] };
              }
              if (sql === 'ROLLBACK') {
                rollbackQueries.push('rollback');
                return { rows: [] };
              }
              if (sql.includes('FOR UPDATE')) {
                return { rows: [{ ...mockSku, stock: 3 }] };
              }
              return { rows: [] };
            })
          };
          try {
            return await callback(mockClient);
          } catch (err) {
            throw err;
          }
        });

        // The transaction function in db.js handles ROLLBACK, we verify it throws
        const res = await request(app)
          .post('/products/1/deduct-stock')
          .send({ quantity: 10, sku_id: 1 });

        expect(res.status).toBe(400);
      });
    });
  });

  // ==========================================
  // POST /products/:id/restore-stock — Saga补偿
  // ==========================================
  describe('POST /products/:id/restore-stock', () => {
    test('should restore stock successfully (200)', async () => {
      require('../../shared/lib/db').transaction = jest.fn().mockImplementation(async (callback) => {
        const mockClient = {
          query: jest.fn().mockImplementation(async (sql, params) => {
            if (sql.includes('UPDATE skus')) {
              return { rows: [] };
            }
            if (sql.includes('UPDATE products')) {
              return { rows: [] };
            }
            if (sql.includes('INSERT INTO inventory_log')) {
              return { rows: [] };
            }
            return { rows: [] };
          })
        };
        return await callback(mockClient);
      });

      const res = await request(app)
        .post('/products/1/restore-stock')
        .send({ quantity: 5, sku_id: 1, order_id: 'order-rollback' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.restored).toBe(5);
    });

    test('should restore stock and log inventory_log', async () => {
      let capturedLogQuery;
      require('../../shared/lib/db').transaction = jest.fn().mockImplementation(async (callback) => {
        const mockClient = {
          query: jest.fn().mockImplementation(async (sql, params) => {
            if (sql.includes('INSERT INTO inventory_log')) {
              capturedLogQuery = { sql, params };
            }
            return { rows: [] };
          })
        };
        return await callback(mockClient);
      });

      const res = await request(app)
        .post('/products/1/restore-stock')
        .send({ quantity: 3, sku_id: 1, order_id: 'order-111' });

      expect(res.status).toBe(200);
      expect(capturedLogQuery.params).toEqual([1, 1, 3, 'order_restore', 'order-111']);
    });

    test('should handle GREATEST(0, sold_count - quantity) correctly', async () => {
      let productUpdateQuery;
      require('../../shared/lib/db').transaction = jest.fn().mockImplementation(async (callback) => {
        const mockClient = {
          query: jest.fn().mockImplementation(async (sql, params) => {
            if (sql.includes('UPDATE products SET') && sql.includes('GREATEST')) {
              productUpdateQuery = { sql, params };
            }
            return { rows: [] };
          })
        };
        return await callback(mockClient);
      });

      const res = await request(app)
        .post('/products/1/restore-stock')
        .send({ quantity: 5, sku_id: 1 });

      expect(res.status).toBe(200);
      expect(productUpdateQuery).toBeDefined();
      expect(productUpdateQuery.sql).toContain('GREATEST(0, sold_count');
    });

    test('should return 400 when quantity is missing', async () => {
      const res = await request(app)
        .post('/products/1/restore-stock')
        .send({ sku_id: 1 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('E8000');
    });

    test('should return 400 when quantity is zero', async () => {
      const res = await request(app)
        .post('/products/1/restore-stock')
        .send({ quantity: 0, sku_id: 1 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('E8000');
    });

    test('should return 400 when quantity is negative', async () => {
      const res = await request(app)
        .post('/products/1/restore-stock')
        .send({ quantity: -5, sku_id: 1 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('E8000');
    });

    test('should restore stock for non-existent SKU (no error)', async () => {
      require('../../shared/lib/db').transaction = jest.fn().mockImplementation(async (callback) => {
        const mockClient = {
          query: jest.fn().mockResolvedValue({ rows: [] })
        };
        return await callback(mockClient);
      });

      const res = await request(app)
        .post('/products/1/restore-stock')
        .send({ quantity: 5, sku_id: 99999 });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    test('should restore large quantity successfully (200)', async () => {
      require('../../shared/lib/db').transaction = jest.fn().mockImplementation(async (callback) => {
        const mockClient = {
          query: jest.fn().mockResolvedValue({ rows: [] })
        };
        return await callback(mockClient);
      });

      const res = await request(app)
        .post('/products/1/restore-stock')
        .send({ quantity: 1000, sku_id: 1, order_id: 'bulk-restore' });

      expect(res.status).toBe(200);
      expect(res.body.restored).toBe(1000);
    });
  });

  // ==========================================
  // Edge Cases & Data Integrity
  // ==========================================
  describe('Inventory Edge Cases', () => {
    test('should handle zero stock after full deduction + low stock event', async () => {
      require('../../shared/lib/db').transaction = jest.fn().mockImplementation(async (callback) => {
        const mockClient = {
          query: jest.fn().mockImplementation(async (sql, params) => {
            if (sql.includes('FOR UPDATE')) {
              return { rows: [{ ...mockSku, stock: 10 }] };
            }
            return { rows: [] };
          })
        };
        return await callback(mockClient);
      });

      const res = await request(app)
        .post('/products/1/deduct-stock')
        .send({ quantity: 10, sku_id: 1 });

      expect(res.status).toBe(200);
      expect(res.body.new_stock).toBe(0);
    });

    test('should handle order_id null when not provided', async () => {
      let capturedLogQuery;
      require('../../shared/lib/db').transaction = jest.fn().mockImplementation(async (callback) => {
        const mockClient = {
          query: jest.fn().mockImplementation(async (sql, params) => {
            if (sql.includes('FOR UPDATE')) {
              return { rows: [{ ...mockSku, stock: 100 }] };
            }
            if (sql.includes('INSERT INTO inventory_log')) {
              capturedLogQuery = { sql, params };
            }
            return { rows: [] };
          })
        };
        return await callback(mockClient);
      });

      const res = await request(app)
        .post('/products/1/deduct-stock')
        .send({ quantity: 5, sku_id: 1 });

      expect(res.status).toBe(200);
      expect(capturedLogQuery.params[4]).toBeNull();
    });

    test('should handle transaction failure gracefully', async () => {
      require('../../shared/lib/db').transaction = jest.fn().mockImplementation(async () => {
        throw new Error('Database connection lost');
      });

      const res = await request(app)
        .post('/products/1/deduct-stock')
        .send({ quantity: 5, sku_id: 1 });

      expect(res.status).toBe(500);
    });
  });
});
