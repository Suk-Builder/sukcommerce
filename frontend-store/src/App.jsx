import React, { createContext, useReducer, useState, useContext } from 'react'
import { Routes, Route, Link, useNavigate, useParams } from 'react-router-dom'
import {
  ShoppingCart,
  Search,
  Star,
  Trash2,
  Plus,
  Minus,
  Package,
  ChevronRight,
  Home,
  Grid3X3,
  ClipboardList,
  X,
  CheckCircle,
  Heart,
  Truck,
  Shield,
  RotateCcw,
  Menu,
} from 'lucide-react'

/* ============ Product Data ============ */

const products = [
  {
    id: 1,
    name: '无线蓝牙耳机 Pro',
    emoji: '🎧',
    price: 299,
    originalPrice: 399,
    category: '电子',
    rating: 4.8,
    reviews: 2341,
    sales: 8920,
    description: '主动降噪，40小时续航，Hi-Res音质认证。采用新一代蓝牙5.3技术，低延迟传输，支持多设备无缝切换。',
    tags: ['降噪', '长续航', 'Hi-Res'],
  },
  {
    id: 2,
    name: '机械键盘 RGB',
    emoji: '⌨️',
    price: 499,
    originalPrice: 699,
    category: '电子',
    rating: 4.7,
    reviews: 1856,
    sales: 5670,
    description: '热插拔轴体，全键无冲，1680万色RGB背光。支持自定义宏编程，PBT双色注塑键帽，手感细腻持久耐用。',
    tags: ['RGB', '热插拔', 'PBT键帽'],
  },
  {
    id: 3,
    name: '显示器支架臂',
    emoji: '🖥️',
    price: 199,
    originalPrice: 299,
    category: '配件',
    rating: 4.6,
    reviews: 987,
    sales: 4450,
    description: '气弹簧升降，360度旋转，支持17-32英寸显示器。桌面夹持安装免打孔，铝合金材质承重力强。',
    tags: ['气弹簧', '360旋转', '铝合金'],
  },
  {
    id: 4,
    name: '便携充电宝 20000mAh',
    emoji: '🔋',
    price: 129,
    originalPrice: 199,
    category: '配件',
    rating: 4.9,
    reviews: 5678,
    sales: 12030,
    description: '20000mAh大容量，支持65W PD快充，三输出口同时充电。航空级安全认证，轻薄便携，出差旅行必备。',
    tags: ['PD快充', '大容量', '多口输出'],
  },
  {
    id: 5,
    name: '27寸 4K 显示器',
    emoji: '🖥️',
    price: 1599,
    originalPrice: 2199,
    category: '电子',
    rating: 4.7,
    reviews: 1234,
    sales: 2340,
    description: '4K超高清分辨率，IPS面板，99% sRGB色域覆盖。Type-C一线连，内置音箱，低蓝光护眼技术。',
    tags: ['4K', 'IPS', 'Type-C'],
  },
  {
    id: 6,
    name: '人体工学鼠标',
    emoji: '🖱️',
    price: 259,
    originalPrice: 359,
    category: '配件',
    rating: 4.5,
    reviews: 2134,
    sales: 6780,
    description: '垂直握持设计，有效缓解手腕疲劳。支持2400DPI四档调节，2.4G无线连接，静音按键不打扰。',
    tags: ['人体工学', '静音', '无线'],
  },
  {
    id: 7,
    name: '蓝牙智能音箱',
    emoji: '🔊',
    price: 349,
    originalPrice: 499,
    category: '电子',
    rating: 4.8,
    reviews: 3456,
    sales: 7890,
    description: '360度环绕立体声，IPX7防水等级，20小时户外续航。支持两台串联组成立体声，智能降噪通话。',
    tags: ['防水', '环绕声', '长续航'],
  },
  {
    id: 8,
    name: '手机支架三脚架',
    emoji: '📱',
    price: 79,
    originalPrice: 129,
    category: '配件',
    rating: 4.4,
    reviews: 4567,
    sales: 15670,
    description: '铝合金伸缩杆，最高拉伸至1.6米。手机夹360度旋转，附赠蓝牙遥控，直播自拍一杆搞定。',
    tags: ['铝合金', '蓝牙遥控', '伸缩'],
  },
]

/* ============ Cart Context ============ */

const CartContext = createContext(null)

function cartReducer(state, action) {
  switch (action.type) {
    case 'ADD': {
      const existing = state.find((item) => item.id === action.product.id)
      if (existing) {
        return state.map((item) =>
          item.id === action.product.id
            ? { ...item, quantity: item.quantity + (action.quantity || 1) }
            : item
        )
      }
      return [...state, { ...action.product, quantity: action.quantity || 1 }]
    }
    case 'REMOVE':
      return state.filter((item) => item.id !== action.id)
    case 'UPDATE_QTY':
      return state.map((item) =>
        item.id === action.id ? { ...item, quantity: Math.max(1, action.quantity) } : item
      )
    case 'CLEAR':
      return []
    default:
      return state
  }
}

function CartProvider({ children }) {
  const [cart, dispatch] = useReducer(cartReducer, [])
  const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0)
  const totalPrice = cart.reduce((sum, item) => sum + item.price * item.quantity, 0)
  return (
    <CartContext.Provider value={{ cart, dispatch, totalItems, totalPrice }}>
      {children}
    </CartContext.Provider>
  )
}

function useCart() {
  return useContext(CartContext)
}

/* ============ Header ============ */

function Header() {
  const { totalItems } = useCart()
  const navigate = useNavigate()
  const [searchQuery, setSearchQuery] = useState('')
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  const handleSearch = (e) => {
    e.preventDefault()
    if (searchQuery.trim()) {
      navigate(`/products?search=${encodeURIComponent(searchQuery.trim())}`)
    }
  }

  return (
    <header className="bg-white shadow-sm sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-2 shrink-0">
            <Package className="w-7 h-7 text-blue-600" />
            <span className="text-xl font-bold text-gray-900">SukCommerce</span>
          </Link>

          {/* Search - hidden on mobile */}
          <form onSubmit={handleSearch} className="hidden sm:flex flex-1 max-w-lg mx-8">
            <div className="relative w-full">
              <input
                type="text"
                placeholder="搜索商品..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            </div>
          </form>

          {/* Nav */}
          <nav className="hidden md:flex items-center gap-6">
            <Link to="/" className="text-gray-600 hover:text-blue-600 font-medium transition-colors">首页</Link>
            <Link to="/products" className="text-gray-600 hover:text-blue-600 font-medium transition-colors">全部商品</Link>
            <Link to="/cart" className="relative text-gray-600 hover:text-blue-600 transition-colors">
              <ShoppingCart className="w-6 h-6" />
              {totalItems > 0 && (
                <span className="absolute -top-2 -right-2 bg-red-500 text-white text-xs w-5 h-5 flex items-center justify-center rounded-full font-bold">
                  {totalItems}
                </span>
              )}
            </Link>
            <Link to="/orders" className="text-gray-600 hover:text-blue-600 transition-colors">
              <ClipboardList className="w-6 h-6" />
            </Link>
          </nav>

          {/* Mobile menu button */}
          <button
            className="md:hidden p-2"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          >
            <Menu className="w-6 h-6 text-gray-600" />
          </button>
        </div>

        {/* Mobile menu */}
        {mobileMenuOpen && (
          <div className="md:hidden border-t py-4 space-y-3">
            <form onSubmit={handleSearch} className="flex sm:hidden mb-3">
              <div className="relative w-full">
                <input
                  type="text"
                  placeholder="搜索商品..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              </div>
            </form>
            <Link to="/" className="flex items-center gap-2 text-gray-600 py-2" onClick={() => setMobileMenuOpen(false)}>
              <Home className="w-5 h-5" /> 首页
            </Link>
            <Link to="/products" className="flex items-center gap-2 text-gray-600 py-2" onClick={() => setMobileMenuOpen(false)}>
              <Grid3X3 className="w-5 h-5" /> 全部商品
            </Link>
            <Link to="/cart" className="flex items-center gap-2 text-gray-600 py-2" onClick={() => setMobileMenuOpen(false)}>
              <ShoppingCart className="w-5 h-5" /> 购物车 ({totalItems})
            </Link>
            <Link to="/orders" className="flex items-center gap-2 text-gray-600 py-2" onClick={() => setMobileMenuOpen(false)}>
              <ClipboardList className="w-5 h-5" /> 我的订单
            </Link>
          </div>
        )}
      </div>
    </header>
  )
}

/* ============ Star Rating ============ */

function StarRating({ rating }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          className={`w-4 h-4 ${
            star <= Math.round(rating) ? 'text-yellow-400 fill-yellow-400' : 'text-gray-300'
          }`}
        />
      ))}
      <span className="text-sm text-gray-500 ml-1">{rating}</span>
    </div>
  )
}

/* ============ Product Card ============ */

function ProductCard({ product }) {
  const { dispatch } = useCart()
  const navigate = useNavigate()

  const handleAdd = (e) => {
    e.stopPropagation()
    dispatch({ type: 'ADD', product })
  }

  return (
    <div
      className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden hover:shadow-md transition-all cursor-pointer group"
      onClick={() => navigate(`/product/${product.id}`)}
    >
      <div className="aspect-square bg-gray-50 flex items-center justify-center text-7xl group-hover:scale-105 transition-transform">
        {product.emoji}
      </div>
      <div className="p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold text-gray-900 line-clamp-2 flex-1">{product.name}</h3>
          <button
            onClick={handleAdd}
            className="shrink-0 bg-blue-600 hover:bg-blue-700 text-white p-2 rounded-lg transition-colors"
            title="加入购物车"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          {product.tags.slice(0, 2).map((tag) => (
            <span key={tag} className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{tag}</span>
          ))}
        </div>
        <div className="mt-2">
          <StarRating rating={product.rating} />
        </div>
        <div className="mt-3 flex items-baseline gap-2">
          <span className="text-lg font-bold text-red-600">¥{product.price}</span>
          <span className="text-sm text-gray-400 line-through">¥{product.originalPrice}</span>
        </div>
      </div>
    </div>
  )
}

/* ============ Home ============ */

function HomePage() {
  const { dispatch } = useCart()
  const navigate = useNavigate()
  const hotProducts = products.slice(0, 4)
  const allProducts = products

  const handleQuickAdd = (product) => {
    dispatch({ type: 'ADD', product })
  }

  return (
    <div>
      {/* Banner */}
      <div className="bg-blue-600 text-white rounded-2xl p-6 sm:p-12 mb-10 relative overflow-hidden">
        <div className="absolute inset-0 bg-white opacity-5" style={{
          backgroundImage: 'radial-gradient(circle at 2px 2px, white 1px, transparent 0)',
          backgroundSize: '32px 32px',
        }} />
        <div className="relative z-10 max-w-2xl">
          <h1 className="text-2xl sm:text-4xl font-bold mb-4">品质数码，触手可及</h1>
          <p className="text-blue-100 mb-6 text-sm sm:text-base">精选数码好物，正品保障，极速发货。新人注册即享专属优惠！</p>
          <button
            onClick={() => navigate('/products')}
            className="bg-white text-blue-600 px-6 py-3 rounded-lg font-semibold hover:bg-blue-50 transition-colors inline-flex items-center gap-2"
          >
            立即选购 <ChevronRight className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Features */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-10">
        {[
          { icon: Truck, text: '全场包邮' },
          { icon: Shield, text: '正品保障' },
          { icon: RotateCcw, text: '7天退换' },
          { icon: CheckCircle, text: '售后无忧' },
        ].map(({ icon: Icon, text }) => (
          <div key={text} className="flex items-center gap-3 bg-white rounded-lg p-4 border border-gray-100">
            <Icon className="w-5 h-5 text-blue-600" />
            <span className="text-sm font-medium text-gray-700">{text}</span>
          </div>
        ))}
      </div>

      {/* Hot Products */}
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-xl sm:text-2xl font-bold text-gray-900">热门推荐</h2>
        <button onClick={() => navigate('/products')} className="text-blue-600 hover:underline text-sm font-medium">
          查看全部
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 mb-12">
        {hotProducts.map((p) => (
          <ProductCard key={p.id} product={p} />
        ))}
      </div>

      {/* All Products Preview */}
      <h2 className="text-xl sm:text-2xl font-bold text-gray-900 mb-6">精选好物</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {allProducts.slice(4).map((p) => (
          <ProductCard key={p.id} product={p} />
        ))}
      </div>
    </div>
  )
}

/* ============ Products ============ */

function ProductsPage() {
  const [activeCategory, setActiveCategory] = useState('全部')
  const { dispatch } = useCart()

  const categories = ['全部', '电子', '配件']
  const filtered = activeCategory === '全部'
    ? products
    : products.filter((p) => p.category === activeCategory)

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-6">全部商品</h2>

      {/* Category Filter */}
      <div className="flex gap-3 mb-8">
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setActiveCategory(cat)}
            className={`px-5 py-2 rounded-full text-sm font-medium transition-colors ${
              activeCategory === cat
                ? 'bg-blue-600 text-white'
                : 'bg-white text-gray-600 border border-gray-200 hover:border-blue-300'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Product Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        {filtered.map((p) => (
          <ProductCard key={p.id} product={p} />
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-20 text-gray-400">
          <Package className="w-16 h-16 mx-auto mb-4" />
          <p>暂无商品</p>
        </div>
      )}
    </div>
  )
}

/* ============ Product Detail ============ */

function ProductDetail() {
  const { id } = useParams()
  const { dispatch } = useCart()
  const navigate = useNavigate()
  const [qty, setQty] = useState(1)

  const product = products.find((p) => p.id === Number(id))

  if (!product) {
    return (
      <div className="text-center py-20">
        <p className="text-gray-400 mb-4">商品不存在</p>
        <button onClick={() => navigate('/products')} className="text-blue-600 underline">
          返回商品列表
        </button>
      </div>
    )
  }

  const handleAdd = () => {
    dispatch({ type: 'ADD', product, quantity: qty })
  }

  const related = products.filter((p) => p.category === product.category && p.id !== product.id).slice(0, 3)

  return (
    <div>
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-gray-500 mb-6">
        <Link to="/" className="hover:text-blue-600">首页</Link>
        <ChevronRight className="w-4 h-4" />
        <Link to="/products" className="hover:text-blue-600">全部商品</Link>
        <ChevronRight className="w-4 h-4" />
        <span className="text-gray-900">{product.name}</span>
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 p-6 sm:p-10">
          {/* Image */}
          <div className="aspect-square bg-gray-50 rounded-xl flex items-center justify-center text-9xl">
            {product.emoji}
          </div>

          {/* Info */}
          <div className="flex flex-col">
            <div className="flex items-center gap-2 mb-2">
              <span className="bg-blue-100 text-blue-700 text-xs px-2 py-1 rounded-full font-medium">{product.category}</span>
              <span className="text-sm text-gray-400">销量 {product.sales}+</span>
            </div>

            <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 mb-3">{product.name}</h1>

            <div className="mb-4">
              <StarRating rating={product.rating} />
              <span className="text-sm text-gray-400 ml-2">{product.reviews} 条评价</span>
            </div>

            <div className="flex items-baseline gap-3 mb-6">
              <span className="text-3xl font-bold text-red-600">¥{product.price}</span>
              <span className="text-lg text-gray-400 line-through">¥{product.originalPrice}</span>
              <span className="bg-red-100 text-red-600 text-sm px-2 py-1 rounded-full font-medium">
                省¥{product.originalPrice - product.price}
              </span>
            </div>

            <p className="text-gray-600 mb-6 leading-relaxed">{product.description}</p>

            <div className="flex flex-wrap gap-2 mb-8">
              {product.tags.map((tag) => (
                <span key={tag} className="bg-gray-100 text-gray-600 text-sm px-3 py-1.5 rounded-full">{tag}</span>
              ))}
            </div>

            {/* Quantity */}
            <div className="flex items-center gap-4 mb-8">
              <span className="text-gray-600 font-medium">数量</span>
              <div className="flex items-center border border-gray-200 rounded-lg">
                <button
                  onClick={() => setQty(Math.max(1, qty - 1))}
                  className="p-2 hover:bg-gray-100 transition-colors"
                >
                  <Minus className="w-4 h-4" />
                </button>
                <span className="w-12 text-center font-semibold">{qty}</span>
                <button
                  onClick={() => setQty(qty + 1)}
                  className="p-2 hover:bg-gray-100 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-4 mt-auto">
              <button
                onClick={handleAdd}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white py-3.5 rounded-xl font-semibold transition-colors flex items-center justify-center gap-2"
              >
                <ShoppingCart className="w-5 h-5" />
                加入购物车
              </button>
              <button className="p-3.5 border border-gray-200 rounded-xl hover:bg-gray-50 transition-colors">
                <Heart className="w-5 h-5 text-gray-400" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Related Products */}
      {related.length > 0 && (
        <div className="mt-12">
          <h3 className="text-xl font-bold text-gray-900 mb-6">相关推荐</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            {related.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/* ============ Cart ============ */

function CartPage() {
  const { cart, dispatch, totalPrice } = useCart()
  const navigate = useNavigate()

  if (cart.length === 0) {
    return (
      <div className="text-center py-20">
        <ShoppingCart className="w-20 h-20 mx-auto text-gray-300 mb-6" />
        <h2 className="text-xl font-semibold text-gray-400 mb-4">购物车是空的</h2>
        <button
          onClick={() => navigate('/products')}
          className="bg-blue-600 text-white px-6 py-2.5 rounded-lg font-medium hover:bg-blue-700 transition-colors"
        >
          去逛逛
        </button>
      </div>
    )
  }

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-6">购物车 ({cart.length})</h2>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Cart Items */}
        <div className="lg:col-span-2 space-y-4">
          {cart.map((item) => (
            <div
              key={item.id}
              className="bg-white rounded-xl border border-gray-100 p-4 flex items-center gap-4 hover:shadow-sm transition-shadow"
            >
              <div
                className="w-20 h-20 bg-gray-50 rounded-lg flex items-center justify-center text-3xl shrink-0 cursor-pointer"
                onClick={() => navigate(`/product/${item.id}`)}
              >
                {item.emoji}
              </div>
              <div className="flex-1 min-w-0">
                <h3
                  className="font-semibold text-gray-900 truncate cursor-pointer hover:text-blue-600"
                  onClick={() => navigate(`/product/${item.id}`)}
                >
                  {item.name}
                </h3>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-red-600 font-bold">¥{item.price}</span>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center border border-gray-200 rounded-lg">
                  <button
                    onClick={() => dispatch({ type: 'UPDATE_QTY', id: item.id, quantity: item.quantity - 1 })}
                    className="p-2 hover:bg-gray-100 transition-colors"
                  >
                    <Minus className="w-4 h-4" />
                  </button>
                  <span className="w-10 text-center font-semibold">{item.quantity}</span>
                  <button
                    onClick={() => dispatch({ type: 'UPDATE_QTY', id: item.id, quantity: item.quantity + 1 })}
                    className="p-2 hover:bg-gray-100 transition-colors"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
                <button
                  onClick={() => dispatch({ type: 'REMOVE', id: item.id })}
                  className="p-2 text-gray-400 hover:text-red-500 transition-colors"
                  title="删除"
                >
                  <Trash2 className="w-5 h-5" />
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* Summary */}
        <div className="bg-white rounded-xl border border-gray-100 p-6 h-fit">
          <h3 className="font-semibold text-gray-900 mb-4">订单摘要</h3>
          <div className="space-y-3 mb-6">
            <div className="flex justify-between text-gray-600">
              <span>商品小计</span>
              <span>¥{totalPrice}</span>
            </div>
            <div className="flex justify-between text-gray-600">
              <span>运费</span>
              <span className="text-green-600">免运费</span>
            </div>
            <div className="border-t pt-3 flex justify-between">
              <span className="font-semibold text-gray-900">合计</span>
              <span className="text-xl font-bold text-red-600">¥{totalPrice}</span>
            </div>
          </div>
          <button className="w-full bg-blue-600 hover:bg-blue-700 text-white py-3.5 rounded-xl font-semibold transition-colors">
            立即结算
          </button>
          <button
            onClick={() => navigate('/products')}
            className="w-full mt-3 border border-gray-200 text-gray-600 py-3 rounded-xl font-medium hover:bg-gray-50 transition-colors"
          >
            继续购物
          </button>
        </div>
      </div>
    </div>
  )
}

/* ============ Orders ============ */

function OrdersPage() {
  const mockOrders = [
    { id: 'ORD2024001', date: '2024-06-20', items: ['无线蓝牙耳机 Pro'], total: 299, status: '已完成' },
    { id: 'ORD2024002', date: '2024-06-18', items: ['机械键盘 RGB', '手机支架三脚架'], total: 578, status: '已完成' },
    { id: 'ORD2024003', date: '2024-06-15', items: ['便携充电宝 20000mAh'], total: 129, status: '配送中' },
  ]

  const statusColors = {
    '已完成': 'bg-green-100 text-green-700',
    '配送中': 'bg-blue-100 text-blue-700',
    '待发货': 'bg-yellow-100 text-yellow-700',
  }

  return (
    <div>
      <h2 className="text-2xl font-bold text-gray-900 mb-6">我的订单</h2>
      <div className="space-y-4">
        {mockOrders.map((order) => (
          <div key={order.id} className="bg-white rounded-xl border border-gray-100 p-6 hover:shadow-sm transition-shadow">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-4">
                <span className="font-semibold text-gray-900">{order.id}</span>
                <span className="text-sm text-gray-400">{order.date}</span>
              </div>
              <span className={`text-sm px-3 py-1 rounded-full font-medium ${statusColors[order.status]}`}>
                {order.status}
              </span>
            </div>
            <div className="text-gray-600 mb-4">
              {order.items.join('、')}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-lg font-bold text-red-600">¥{order.total}</span>
              <button className="text-blue-600 hover:underline text-sm font-medium">
                查看详情
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ============ Footer ============ */

function Footer() {
  return (
    <footer className="bg-white border-t border-gray-100 mt-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
          <div>
            <div className="flex items-center gap-2 mb-4">
              <Package className="w-6 h-6 text-blue-600" />
              <span className="text-lg font-bold text-gray-900">SukCommerce</span>
            </div>
            <p className="text-gray-500 text-sm">品质数码，触手可及。为您提供最优质的数码产品购物体验。</p>
          </div>
          <div>
            <h4 className="font-semibold text-gray-900 mb-4">客户服务</h4>
            <ul className="space-y-2 text-sm text-gray-500">
              <li><span className="hover:text-blue-600 cursor-pointer">帮助中心</span></li>
              <li><span className="hover:text-blue-600 cursor-pointer">退换货政策</span></li>
              <li><span className="hover:text-blue-600 cursor-pointer">配送说明</span></li>
            </ul>
          </div>
          <div>
            <h4 className="font-semibold text-gray-900 mb-4">关于我们</h4>
            <ul className="space-y-2 text-sm text-gray-500">
              <li><span className="hover:text-blue-600 cursor-pointer">公司简介</span></li>
              <li><span className="hover:text-blue-600 cursor-pointer">联系我们</span></li>
              <li><span className="hover:text-blue-600 cursor-pointer">加入我们</span></li>
            </ul>
          </div>
        </div>
        <div className="border-t border-gray-100 mt-8 pt-8 text-center text-sm text-gray-400">
          © 2024 SukCommerce. All rights reserved.
        </div>
      </div>
    </footer>
  )
}

/* ============ App ============ */

export default function App() {
  return (
    <CartProvider>
      <div className="min-h-screen flex flex-col bg-gray-50">
        <Header />
        <main className="flex-1 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 w-full">
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/products" element={<ProductsPage />} />
            <Route path="/product/:id" element={<ProductDetail />} />
            <Route path="/cart" element={<CartPage />} />
            <Route path="/orders" element={<OrdersPage />} />
          </Routes>
        </main>
        <Footer />
      </div>
    </CartProvider>
  )
}
