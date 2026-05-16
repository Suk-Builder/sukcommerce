import React, { useState } from 'react'
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import {
  Layout,
  Menu,
  Card,
  Statistic,
  Table,
  Tag,
  Button,
  Modal,
  Form,
  Input,
  InputNumber,
  Select,
  message,
  Row,
  Col,
  Avatar,
  Badge,
  Space,
  Switch,
  DatePicker,
  Tooltip,
} from 'antd'
import {
  DashboardOutlined,
  ShoppingCartOutlined,
  InboxOutlined,
  UserOutlined,
  GiftOutlined,
  SettingOutlined,
  LogoutOutlined,
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  EyeOutlined,
  ExclamationCircleOutlined,
  SearchOutlined,
  ReloadOutlined,
} from '@ant-design/icons'

const { Sider, Content, Header } = Layout
const { Option } = Select
const { confirm } = Modal

/* ============ Mock Data ============ */

const dashboardStats = [
  { title: '今日订单', value: 128, prefix: '', color: '#1890ff' },
  { title: '今日销售额', value: 8960, prefix: '¥', color: '#52c41a' },
  { title: '待发货', value: 23, prefix: '', color: '#faad14' },
  { title: '注册用户', value: 3567, prefix: '', color: '#eb2f96' },
]

const weekDays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
const weekOrders = [82, 95, 78, 110, 128, 95, 140]
const weekSales = [4200, 5800, 3900, 7200, 8960, 6100, 9500]

const orderData = [
  { id: 'ORD2024001', user: '张三', amount: 299, status: '已完成', time: '2024-06-20 10:30', items: '无线耳机 x1' },
  { id: 'ORD2024002', user: '李四', amount: 1599, status: '待发货', time: '2024-06-20 11:15', items: '机械键盘 x1' },
  { id: 'ORD2024003', user: '王五', amount: 89, status: '待付款', time: '2024-06-20 12:00', items: '手机支架 x2' },
  { id: 'ORD2024004', user: '赵六', amount: 499, status: '已完成', time: '2024-06-20 13:45', items: '充电宝 x1' },
  { id: 'ORD2024005', user: '钱七', amount: 2199, status: '待发货', time: '2024-06-20 14:20', items: '显示器 x1' },
  { id: 'ORD2024006', user: '孙八', amount: 128, status: '已取消', time: '2024-06-20 15:00', items: '数据线 x3' },
  { id: 'ORD2024007', user: '周九', amount: 699, status: '已完成', time: '2024-06-20 16:30', items: '蓝牙音箱 x1' },
  { id: 'ORD2024008', user: '吴十', amount: 359, status: '待发货', time: '2024-06-20 17:00', items: '鼠标 x1, 鼠标垫 x1' },
]

const productData = [
  { id: 1, name: '无线蓝牙耳机', price: 299, stock: 156, category: '音频', sales: 892 },
  { id: 2, name: '机械键盘', price: 499, stock: 78, category: '外设', sales: 567 },
  { id: 3, name: '显示器支架', price: 199, stock: 234, category: '配件', sales: 445 },
  { id: 4, name: '便携充电宝', price: 129, stock: 312, category: '配件', sales: 1203 },
  { id: 5, name: '27寸显示器', price: 1599, stock: 45, category: '显示', sales: 234 },
  { id: 6, name: '人体工学鼠标', price: 259, stock: 189, category: '外设', sales: 678 },
]

const userData = [
  { id: 1, name: '张三', email: 'zhangsan@example.com', phone: '138****1234', orders: 12, total: 3599, status: '正常' },
  { id: 2, name: '李四', email: 'lisi@example.com', phone: '139****5678', orders: 8, total: 2199, status: '正常' },
  { id: 3, name: '王五', email: 'wangwu@example.com', phone: '137****9012', orders: 25, total: 8999, status: '正常' },
  { id: 4, name: '赵六', email: 'zhaoliu@example.com', phone: '136****3456', orders: 3, total: 599, status: '禁用' },
  { id: 5, name: '钱七', email: 'qianqi@example.com', phone: '135****7890', orders: 15, total: 5699, status: '正常' },
]

const couponData = [
  { id: 1, name: '新人专享券', type: '满减', value: '满100减20', used: 128, total: 500, status: '进行中' },
  { id: 2, name: '618大促券', type: '折扣', value: '8.5折', used: 356, total: 1000, status: '进行中' },
  { id: 3, name: '运费减免券', type: '免邮', value: '免运费', used: 89, total: 300, status: '已结束' },
  { id: 4, name: '会员专享券', type: '满减', value: '满500减100', used: 45, total: 200, status: '进行中' },
]

/* ============ Dashboard ============ */

function Dashboard() {
  const maxOrder = Math.max(...weekOrders)
  const maxSale = Math.max(...weekSales)

  return (
    <div>
      <h2 style={{ marginBottom: 24 }}>数据看板</h2>
      <Row gutter={[16, 16]}>
        {dashboardStats.map((s) => (
          <Col xs={24} sm={12} lg={6} key={s.title}>
            <Card>
              <Statistic
                title={s.title}
                value={s.value}
                prefix={s.prefix}
                valueStyle={{ color: s.color, fontWeight: 'bold' }}
              />
            </Card>
          </Col>
        ))}
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 24 }}>
        <Col xs={24} lg={12}>
          <Card title="近7日订单量" extra={<ReloadOutlined style={{ cursor: 'pointer' }} />}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, height: 200, padding: '10px 0' }}>
              {weekOrders.map((v, i) => (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>{v}</span>
                  <div
                    style={{
                      width: '100%',
                      height: `${(v / maxOrder) * 160}px`,
                      background: 'linear-gradient(to top, #1890ff, #69c0ff)',
                      borderRadius: '4px 4px 0 0',
                      transition: 'height 0.3s',
                    }}
                  />
                  <span style={{ fontSize: 12, color: '#999', marginTop: 6 }}>{weekDays[i]}</span>
                </div>
              ))}
            </div>
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title="近7日销售额" extra={<ReloadOutlined style={{ cursor: 'pointer' }} />}>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, height: 200, padding: '10px 0' }}>
              {weekSales.map((v, i) => (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: '#666', marginBottom: 4 }}>¥{(v / 1000).toFixed(1)}k</span>
                  <div
                    style={{
                      width: '100%',
                      height: `${(v / maxSale) * 160}px`,
                      background: 'linear-gradient(to top, #52c41a, #95de64)',
                      borderRadius: '4px 4px 0 0',
                      transition: 'height 0.3s',
                    }}
                  />
                  <span style={{ fontSize: 12, color: '#999', marginTop: 6 }}>{weekDays[i]}</span>
                </div>
              ))}
            </div>
          </Card>
        </Col>
      </Row>
    </div>
  )
}

/* ============ Orders ============ */

function Orders() {
  const [orders, setOrders] = useState(orderData)
  const [searchText, setSearchText] = useState('')

  const statusColors = {
    '已完成': 'success',
    '待发货': 'processing',
    '待付款': 'warning',
    '已取消': 'default',
  }

  const filteredOrders = orders.filter(
    (o) =>
      o.id.toLowerCase().includes(searchText.toLowerCase()) ||
      o.user.includes(searchText)
  )

  const handleDelete = (id) => {
    confirm({
      title: '确认删除该订单？',
      icon: <ExclamationCircleOutlined />,
      onOk() {
        setOrders(orders.filter((o) => o.id !== id))
        message.success('订单已删除')
      },
    })
  }

  const columns = [
    { title: '订单号', dataIndex: 'id', key: 'id' },
    { title: '用户', dataIndex: 'user', key: 'user' },
    { title: '商品', dataIndex: 'items', key: 'items', ellipsis: true },
    {
      title: '金额',
      dataIndex: 'amount',
      key: 'amount',
      render: (v) => <span style={{ color: '#f5222d', fontWeight: 'bold' }}>¥{v}</span>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (v) => <Tag color={statusColors[v]}>{v}</Tag>,
    },
    { title: '时间', dataIndex: 'time', key: 'time' },
    {
      title: '操作',
      key: 'action',
      render: (_, record) => (
        <Space>
          <Tooltip title="查看"><Button icon={<EyeOutlined />} size="small" /></Tooltip>
          <Tooltip title="编辑"><Button icon={<EditOutlined />} size="small" /></Tooltip>
          <Tooltip title="删除"><Button icon={<DeleteOutlined />} size="small" danger onClick={() => handleDelete(record.id)} /></Tooltip>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <h2 style={{ marginBottom: 16 }}>订单管理</h2>
      <Card
        extra={
          <Space>
            <Input
              placeholder="搜索订单号或用户"
              prefix={<SearchOutlined />}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              style={{ width: 220 }}
              allowClear
            />
            <Button icon={<ReloadOutlined />} onClick={() => setOrders(orderData)}>刷新</Button>
          </Space>
        }
      >
        <Table columns={columns} dataSource={filteredOrders} rowKey="id" pagination={{ pageSize: 5 }} />
      </Card>
    </div>
  )
}

/* ============ Products ============ */

function Products() {
  const [products, setProducts] = useState(productData)
  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingProduct, setEditingProduct] = useState(null)
  const [form] = Form.useForm()

  const showAddModal = () => {
    setEditingProduct(null)
    form.resetFields()
    setIsModalOpen(true)
  }

  const showEditModal = (record) => {
    setEditingProduct(record)
    form.setFieldsValue(record)
    setIsModalOpen(true)
  }

  const handleOk = () => {
    form.validateFields().then((values) => {
      if (editingProduct) {
        setProducts(products.map((p) => (p.id === editingProduct.id ? { ...p, ...values } : p)))
        message.success('商品已更新')
      } else {
        const newProduct = { ...values, id: Date.now(), sales: 0 }
        setProducts([...products, newProduct])
        message.success('商品已添加')
      }
      setIsModalOpen(false)
    })
  }

  const handleDelete = (id) => {
    confirm({
      title: '确认删除该商品？',
      icon: <ExclamationCircleOutlined />,
      onOk() {
        setProducts(products.filter((p) => p.id !== id))
        message.success('商品已删除')
      },
    })
  }

  const columns = [
    { title: 'ID', dataIndex: 'id', key: 'id', width: 60 },
    { title: '商品名称', dataIndex: 'name', key: 'name' },
    { title: '分类', dataIndex: 'category', key: 'category' },
    {
      title: '价格',
      dataIndex: 'price',
      key: 'price',
      render: (v) => <span style={{ color: '#f5222d' }}>¥{v}</span>,
    },
    { title: '库存', dataIndex: 'stock', key: 'stock' },
    { title: '销量', dataIndex: 'sales', key: 'sales' },
    {
      title: '操作',
      key: 'action',
      render: (_, record) => (
        <Space>
          <Button icon={<EditOutlined />} size="small" onClick={() => showEditModal(record)}>编辑</Button>
          <Button icon={<DeleteOutlined />} size="small" danger onClick={() => handleDelete(record.id)}>删除</Button>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>商品管理</h2>
        <Button type="primary" icon={<PlusOutlined />} onClick={showAddModal}>
          新增商品
        </Button>
      </div>
      <Card>
        <Table columns={columns} dataSource={products} rowKey="id" pagination={{ pageSize: 5 }} />
      </Card>

      <Modal
        title={editingProduct ? '编辑商品' : '新增商品'}
        open={isModalOpen}
        onOk={handleOk}
        onCancel={() => setIsModalOpen(false)}
        okText="保存"
        cancelText="取消"
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="name" label="商品名称" rules={[{ required: true, message: '请输入商品名称' }]}>
            <Input placeholder="请输入商品名称" />
          </Form.Item>
          <Form.Item name="category" label="分类" rules={[{ required: true, message: '请选择分类' }]}>
            <Select placeholder="请选择分类">
              <Option value="音频">音频</Option>
              <Option value="外设">外设</Option>
              <Option value="配件">配件</Option>
              <Option value="显示">显示</Option>
            </Select>
          </Form.Item>
          <Form.Item name="price" label="价格" rules={[{ required: true, message: '请输入价格' }]}>
            <InputNumber min={0} style={{ width: '100%' }} prefix="¥" placeholder="请输入价格" />
          </Form.Item>
          <Form.Item name="stock" label="库存" rules={[{ required: true, message: '请输入库存' }]}>
            <InputNumber min={0} style={{ width: '100%' }} placeholder="请输入库存" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

/* ============ Users ============ */

function Users() {
  const [users, setUsers] = useState(userData)

  const toggleStatus = (id) => {
    setUsers(
      users.map((u) =>
        u.id === id ? { ...u, status: u.status === '正常' ? '禁用' : '正常' } : u
      )
    )
    message.success('状态已更新')
  }

  const columns = [
    {
      title: '头像',
      dataIndex: 'name',
      key: 'avatar',
      width: 60,
      render: (v) => <Avatar style={{ backgroundColor: '#1890ff' }}>{v[0]}</Avatar>,
    },
    { title: '姓名', dataIndex: 'name', key: 'name' },
    { title: '邮箱', dataIndex: 'email', key: 'email' },
    { title: '手机号', dataIndex: 'phone', key: 'phone' },
    { title: '订单数', dataIndex: 'orders', key: 'orders' },
    {
      title: '消费总额',
      dataIndex: 'total',
      key: 'total',
      render: (v) => <span style={{ color: '#f5222d' }}>¥{v}</span>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (v) => (
        <Tag color={v === '正常' ? 'success' : 'error'}>{v}</Tag>
      ),
    },
    {
      title: '操作',
      key: 'action',
      render: (_, record) => (
        <Switch
          checked={record.status === '正常'}
          onChange={() => toggleStatus(record.id)}
          checkedChildren="正常"
          unCheckedChildren="禁用"
        />
      ),
    },
  ]

  return (
    <div>
      <h2 style={{ marginBottom: 16 }}>用户管理</h2>
      <Card>
        <Table columns={columns} dataSource={users} rowKey="id" pagination={{ pageSize: 5 }} />
      </Card>
    </div>
  )
}

/* ============ Marketing ============ */

function Marketing() {
  const [coupons] = useState(couponData)

  const columns = [
    { title: '优惠券名称', dataIndex: 'name', key: 'name' },
    { title: '类型', dataIndex: 'type', key: 'type' },
    { title: '优惠内容', dataIndex: 'value', key: 'value' },
    {
      title: '使用情况',
      key: 'usage',
      render: (_, record) => (
        <span>
          {record.used} / {record.total}
        </span>
      ),
    },
    {
      title: '使用率',
      key: 'rate',
      render: (_, record) => (
        <Badge
          status={record.used / record.total > 0.8 ? 'error' : record.used / record.total > 0.5 ? 'warning' : 'success'}
          text={`${((record.used / record.total) * 100).toFixed(0)}%`}
        />
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (v) => <Tag color={v === '进行中' ? 'blue' : 'default'}>{v}</Tag>,
    },
    {
      title: '操作',
      key: 'action',
      render: () => (
        <Space>
          <Button size="small" icon={<EditOutlined />}>编辑</Button>
          <Button size="small" danger icon={<DeleteOutlined />}>删除</Button>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>营销工具</h2>
        <Button type="primary" icon={<PlusOutlined />}>新建优惠券</Button>
      </div>
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col span={8}>
          <Card><Statistic title="优惠券总数" value={4} /></Card>
        </Col>
        <Col span={8}>
          <Card><Statistic title="已发放" value={618} /></Card>
        </Col>
        <Col span={8}>
          <Card><Statistic title="已使用" value={523} /></Card>
        </Col>
      </Row>
      <Card title="优惠券列表">
        <Table columns={columns} dataSource={coupons} rowKey="id" pagination={{ pageSize: 4 }} />
      </Card>
    </div>
  )
}

/* ============ Settings ============ */

function Settings() {
  const [form] = Form.useForm()

  const handleSave = () => {
    message.success('设置已保存')
  }

  return (
    <div>
      <h2 style={{ marginBottom: 24 }}>系统设置</h2>
      <Card title="基本设置" style={{ maxWidth: 600 }}>
        <Form form={form} layout="vertical" initialValues={{ siteName: 'SukCommerce', currency: 'CNY' }}>
          <Form.Item name="siteName" label="网站名称">
            <Input />
          </Form.Item>
          <Form.Item name="currency" label="默认货币">
            <Select>
              <Option value="CNY">人民币 (CNY)</Option>
              <Option value="USD">美元 (USD)</Option>
              <Option value="EUR">欧元 (EUR)</Option>
            </Select>
          </Form.Item>
          <Form.Item label="客服邮箱">
            <Input placeholder="support@example.com" />
          </Form.Item>
          <Form.Item label="联系电话">
            <Input placeholder="400-123-4567" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" onClick={handleSave}>保存设置</Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  )
}

/* ============ App ============ */

const menuItems = [
  { key: '/dashboard', icon: <DashboardOutlined />, label: '数据看板' },
  { key: '/orders', icon: <ShoppingCartOutlined />, label: '订单管理' },
  { key: '/products', icon: <InboxOutlined />, label: '商品管理' },
  { key: '/users', icon: <UserOutlined />, label: '用户管理' },
  { key: '/marketing', icon: <GiftOutlined />, label: '营销工具' },
  { key: '/settings', icon: <SettingOutlined />, label: '系统设置' },
]

export default function App() {
  const navigate = useNavigate()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(false)

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider trigger={null} collapsible collapsed={collapsed} theme="dark">
        <div
          style={{
            height: 64,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontSize: collapsed ? 14 : 18,
            fontWeight: 'bold',
            borderBottom: '1px solid rgba(255,255,255,0.1)',
          }}
        >
          {collapsed ? 'SK' : 'SukAdmin'}
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[location.pathname]}
          items={menuItems}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: '#fff',
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            boxShadow: '0 1px 4px rgba(0,0,0,0.1)',
          }}
        >
          <Button type="text" onClick={() => setCollapsed(!collapsed)} style={{ fontSize: 16 }}>
            {collapsed ? '展开' : '收起'}
          </Button>
          <Space>
            <span style={{ color: '#666' }}>管理员</span>
            <Avatar style={{ backgroundColor: '#1890ff' }} icon={<UserOutlined />} />
            <Button type="text" icon={<LogoutOutlined />} danger size="small">
              退出
            </Button>
          </Space>
        </Header>
        <Content style={{ margin: 24, padding: 24, background: '#fff', borderRadius: 8, minHeight: 280 }}>
          <Routes>
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/orders" element={<Orders />} />
            <Route path="/products" element={<Products />} />
            <Route path="/users" element={<Users />} />
            <Route path="/marketing" element={<Marketing />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Dashboard />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  )
}
