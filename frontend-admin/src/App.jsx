/**
 * 管理后台 — React + Ant Design
 * 商品管理 / 订单管理 / 用户管理 / 数据看板 / 营销工具
 */
import React, { useState } from 'react';
import { Layout, Menu, Card, Statistic, Table, Tag, DatePicker, Button, Modal, Form, Input, Select, message } from 'antd';
import {
  DashboardOutlined, ShoppingOutlined, OrderedListOutlined,
  UserOutlined, BarChartOutlined, SettingOutlined, BellOutlined
} from '@ant-design/icons';

const { Sider, Content, Header } = Layout;

// ─── 模拟数据 ───
const mockOrders = Array.from({ length: 20 }, (_, i) => ({
  id: i + 1,
  order_no: `SC202401${String(i).padStart(4,'0')}`,
  user: `user_${i}`,
  amount: (Math.random() * 1000 + 50).toFixed(2),
  status: ['pending','paid','shipped','completed'][Math.floor(Math.random() * 4)],
  created_at: '2024-01-' + String(Math.floor(Math.random() * 28) + 1).padStart(2,'0'),
}));

const mockProducts = Array.from({ length: 15 }, (_, i) => ({
  id: i + 1,
  name: ['无线耳机','机械键盘','显示器支架','Type-C线','鼠标垫','USB Hub','手机壳','充电宝'][i % 8],
  price: (Math.random() * 500 + 20).toFixed(2),
  stock: Math.floor(Math.random() * 200),
  sold: Math.floor(Math.random() * 1000),
  status: Math.random() > 0.2 ? 'active' : 'inactive',
}));

const statusColors = { pending: 'orange', paid: 'green', shipped: 'blue', completed: 'gray', cancelled: 'red' };
const statusLabels = { pending: '待付款', paid: '已付款', shipped: '已发货', completed: '已完成', cancelled: '已取消' };

// ─── 仪表盘 ───
function Dashboard() {
  return (
    <div>
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { title: '今日订单', value: 128, prefix: '¥', suffix: '' },
          { title: '今日销售额', value: 24580, prefix: '¥', suffix: '' },
          { title: '待发货', value: 23, prefix: '', suffix: '单' },
          { title: '注册用户', value: 1842, prefix: '', suffix: '人' },
        ].map((s, i) => (
          <Card key={i}><Statistic title={s.title} value={s.value} prefix={s.prefix} suffix={s.suffix} /></Card>
        ))}
      </div>
      <Card title="近7天销售趋势">
        <div className="h-64 flex items-end gap-2">
          {[45, 62, 38, 75, 55, 88, 72].map((h, i) => (
            <div key={i} className="flex-1 flex flex-col items-center gap-1">
              <div className="w-full bg-blue-500 rounded-t" style={{ height: `${h}%` }} />
              <span className="text-xs text-gray-400">{['一','二','三','四','五','六','日'][i]}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ─── 订单管理 ───
function OrderManagement() {
  const columns = [
    { title: '订单号', dataIndex: 'order_no', key: 'order_no' },
    { title: '用户', dataIndex: 'user', key: 'user' },
    { title: '金额', dataIndex: 'amount', key: 'amount', render: v => `¥${v}` },
    { title: '状态', dataIndex: 'status', key: 'status', render: v => <Tag color={statusColors[v]}>{statusLabels[v]}</Tag> },
    { title: '下单时间', dataIndex: 'created_at', key: 'created_at' },
    { title: '操作', key: 'action', render: () => (
      <div className="space-x-2">
        <Button size="small">详情</Button>
        <Button size="small" type="primary">发货</Button>
      </div>
    )},
  ];
  return <Card title="订单管理"><Table dataSource={mockOrders} columns={columns} rowKey="id" pagination={{ pageSize: 10 }} /></Card>;
}

// ─── 商品管理 ───
function ProductManagement() {
  const [modalVisible, setModalVisible] = useState(false);
  const columns = [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 60 },
    { title: '商品名称', dataIndex: 'name', key: 'name' },
    { title: '价格', dataIndex: 'price', key: 'price', render: v => `¥${v}` },
    { title: '库存', dataIndex: 'stock', key: 'stock' },
    { title: '销量', dataIndex: 'sold', key: 'sold' },
    { title: '状态', dataIndex: 'status', key: 'status', render: v => <Tag color={v === 'active' ? 'green' : 'red'}>{v === 'active' ? '上架' : '下架'}</Tag> },
    { title: '操作', key: 'action', render: () => (
      <div className="space-x-2">
        <Button size="small">编辑</Button>
        <Button size="small" danger>下架</Button>
      </div>
    )},
  ];
  return (
    <>
      <Card title="商品管理" extra={<Button type="primary" onClick={() => setModalVisible(true)}>新增商品</Button>}>
        <Table dataSource={mockProducts} columns={columns} rowKey="id" pagination={{ pageSize: 10 }} />
      </Card>
      <Modal title="新增商品" open={modalVisible} onCancel={() => setModalVisible(false)} footer={[
        <Button onClick={() => setModalVisible(false)}>取消</Button>,
        <Button type="primary" onClick={() => { message.success('商品创建成功'); setModalVisible(false); }}>创建</Button>
      ]}>
        <Form layout="vertical">
          <Form.Item label="商品名称" required><Input placeholder="输入商品名称" /></Form.Item>
          <Form.Item label="价格" required><Input type="number" prefix="¥" /></Form.Item>
          <Form.Item label="库存" required><Input type="number" /></Form.Item>
          <Form.Item label="分类">
            <Select options={[{label:'电子产品',value:'electronics'},{label:'服装',value:'clothing'}]} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

// ─── 主应用 ───
export default function AdminApp() {
  const [collapsed, setCollapsed] = useState(false);
  const [activeKey, setActiveKey] = useState('dashboard');

  const menuItems = [
    { key: 'dashboard', icon: <DashboardOutlined />, label: '数据看板' },
    { key: 'orders', icon: <OrderedListOutlined />, label: '订单管理' },
    { key: 'products', icon: <ShoppingOutlined />, label: '商品管理' },
    { key: 'users', icon: <UserOutlined />, label: '用户管理' },
    { key: 'marketing', icon: <BarChartOutlined />, label: '营销工具' },
    { key: 'settings', icon: <SettingOutlined />, label: '系统设置' },
  ];

  const renderContent = () => {
    switch (activeKey) {
      case 'dashboard': return <Dashboard />;
      case 'orders': return <OrderManagement />;
      case 'products': return <ProductManagement />;
      case 'users': return <Card title="用户管理"><p>用户列表功能开发中...</p></Card>;
      default: return <Dashboard />;
    }
  };

  return (
    <Layout className="h-screen">
      <Sider trigger={null} collapsible collapsed={collapsed} theme="light">
        <div className="h-16 flex items-center justify-center font-bold text-lg text-indigo-600 border-b">
          {collapsed ? 'SC' : 'SukCommerce'}
        </div>
        <Menu mode="inline" selectedKeys={[activeKey]} items={menuItems} onClick={({key}) => setActiveKey(key)} />
      </Sider>
      <Layout>
        <Header className="bg-white px-6 flex items-center justify-between border-b">
          <h2 className="text-lg font-semibold">{menuItems.find(i => i.key === activeKey)?.label}</h2>
          <div className="flex items-center gap-4">
            <BellOutlined className="text-lg cursor-pointer" />
            <span className="text-sm text-gray-600">admin</span>
          </div>
        </Header>
        <Content className="p-6 bg-gray-50 overflow-auto">{renderContent()}</Content>
      </Layout>
    </Layout>
  );
}
