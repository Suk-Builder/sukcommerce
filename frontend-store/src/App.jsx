/**
 * 商城前端 — React + Tailwind
 * 首页 / 商品列表 / 商品详情 / 购物车 / 结算 / 订单中心
 */
import React, { useState, createContext, useContext } from 'react';

const StoreContext = createContext();

const mockProducts = [
  { id:1, name:'AirPods Pro 2', price:1899, image:'🎧', category:'电子', rating:4.8, sold:2300 },
  { id:2, name:'Keychron K3', price:498, image:'⌨️', category:'电子', rating:4.6, sold:890 },
  { id:3, name:'显示器支架', price:299, image:'🖥️', category:'配件', rating:4.5, sold:560 },
  { id:4, name:'Anker充电宝', price:199, image:'🔋', category:'配件', rating:4.7, sold:3400 },
  { id:5, name:'鼠标垫 XL', price:89, image:'🖱️', category:'配件', rating:4.3, sold:1200 },
  { id:6, name:'USB-C Hub', price:259, image:'🔌', category:'配件', rating:4.4, sold:780 },
  { id:7, name:'手机壳', price:59, image:'📱', category:'配件', rating:4.2, sold:5600 },
  { id:8, name:'蓝牙音箱', price:349, image:'🔊', category:'电子', rating:4.6, sold:920 },
];

// ─── Header ───
function Header() {
  const { setPage, cart, search, setSearch } = useContext(StoreContext);
  const cartCount = cart.reduce((s, i) => s + i.quantity, 0);

  return (
    <header className="bg-white border-b sticky top-0 z-50">
      <div className="max-w-6xl mx-auto px-4 h-16 flex items-center gap-6">
        <h1 className="text-xl font-bold text-indigo-600 cursor-pointer" onClick={() => setPage('home')}>SukCommerce</h1>
        <div className="flex-1 max-w-md">
          <input type="text" placeholder="搜索商品..." value={search} onChange={e => setSearch(e.target.value)}
            className="w-full px-4 py-2 border rounded-full text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        </div>
        <nav className="flex items-center gap-4 text-sm">
          <button onClick={() => setPage('home')} className="hover:text-indigo-600">首页</button>
          <button onClick={() => setPage('products')} className="hover:text-indigo-600">全部商品</button>
          <button onClick={() => setPage('cart')} className="relative hover:text-indigo-600">
            购物车{cartCount > 0 && <span className="absolute -top-2 -right-4 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">{cartCount}</span>}
          </button>
          <button onClick={() => setPage('orders')} className="hover:text-indigo-600">我的订单</button>
        </nav>
      </div>
    </header>
  );
}

// ─── 首页 ───
function HomePage() {
  const { setPage, addToCart } = useContext(StoreContext);
  return (
    <div>
      {/* Banner */}
      <div className="bg-gradient-to-r from-indigo-600 to-purple-600 text-white py-16 px-4">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-4xl font-bold mb-4">发现好物，即刻拥有</h2>
          <p className="text-lg opacity-90 mb-6">精选数码配件，品质生活从这里开始</p>
          <button onClick={() => setPage('products')} className="bg-white text-indigo-600 px-6 py-3 rounded-lg font-semibold hover:bg-gray-100">浏览商品</button>
        </div>
      </div>
      {/* 热门商品 */}
      <div className="max-w-6xl mx-auto px-4 py-12">
        <h3 className="text-2xl font-bold mb-6">热门商品</h3>
        <div className="grid grid-cols-4 gap-6">
          {mockProducts.slice(0,4).map(p => (
            <div key={p.id} className="bg-white rounded-xl shadow-sm border hover:shadow-lg transition-shadow cursor-pointer" onClick={() => setPage('product')}>
              <div className="h-40 bg-gray-100 rounded-t-xl flex items-center justify-center text-6xl">{p.image}</div>
              <div className="p-4">
                <h4 className="font-semibold mb-1">{p.name}</h4>
                <div className="flex items-center justify-between">
                  <span className="text-lg font-bold text-red-600">¥{p.price}</span>
                  <span className="text-xs text-gray-400">已售{p.sold}</span>
                </div>
                <button onClick={(e) => { e.stopPropagation(); addToCart(p); }} className="w-full mt-3 bg-indigo-600 text-white py-2 rounded-lg text-sm hover:bg-indigo-700">加入购物车</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── 商品列表 ───
function ProductsPage() {
  const { addToCart, search } = useContext(StoreContext);
  const [category, setCategory] = useState('all');
  const filtered = mockProducts.filter(p => {
    const matchCat = category === 'all' || p.category === category;
    const matchSearch = !search || p.name.includes(search);
    return matchCat && matchSearch;
  });

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <div className="flex gap-4 mb-6">
        {['all','电子','配件'].map(c => (
          <button key={c} onClick={() => setCategory(c)} className={`px-4 py-2 rounded-lg text-sm ${category === c ? 'bg-indigo-600 text-white' : 'bg-gray-100 hover:bg-gray-200'}`}>
            {c === 'all' ? '全部' : c}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-4 gap-6">
        {filtered.map(p => (
          <div key={p.id} className="bg-white rounded-xl shadow-sm border hover:shadow-lg transition-shadow">
            <div className="h-40 bg-gray-100 rounded-t-xl flex items-center justify-center text-6xl">{p.image}</div>
            <div className="p-4">
              <h4 className="font-semibold mb-1">{p.name}</h4>
              <div className="flex items-center gap-1 text-xs text-amber-500 mb-2">{'★'.repeat(Math.floor(p.rating))} <span className="text-gray-400">({p.rating})</span></div>
              <div className="flex items-center justify-between">
                <span className="text-lg font-bold text-red-600">¥{p.price}</span>
                <button onClick={() => addToCart(p)} className="bg-indigo-600 text-white px-3 py-1.5 rounded text-sm hover:bg-indigo-700">加入购物车</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── 购物车 ───
function CartPage() {
  const { cart, updateCartQty, removeFromCart } = useContext(StoreContext);
  const total = cart.reduce((s, i) => s + i.price * i.quantity, 0);

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <h2 className="text-2xl font-bold mb-6">购物车 ({cart.length})</h2>
      {cart.length === 0 ? <div className="text-center py-20 text-gray-400">购物车为空</div> : (
        <>
          <div className="space-y-4 mb-6">
            {cart.map(item => (
              <div key={item.id} className="flex items-center gap-4 bg-white p-4 rounded-xl border">
                <span className="text-4xl">{item.image}</span>
                <div className="flex-1">
                  <h4 className="font-semibold">{item.name}</h4>
                  <p className="text-red-600 font-bold">¥{item.price}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => updateCartQty(item.id, item.quantity - 1)} className="w-8 h-8 rounded border hover:bg-gray-100">-</button>
                  <span className="w-8 text-center">{item.quantity}</span>
                  <button onClick={() => updateCartQty(item.id, item.quantity + 1)} className="w-8 h-8 rounded border hover:bg-gray-100">+</button>
                </div>
                <button onClick={() => removeFromCart(item.id)} className="text-red-500 hover:text-red-700 ml-4">删除</button>
              </div>
            ))}
          </div>
          <div className="bg-white p-6 rounded-xl border flex items-center justify-between">
            <span className="text-gray-600">共 {cart.reduce((s,i)=>s+i.quantity,0)} 件商品</span>
            <div className="flex items-center gap-6">
              <span className="text-xl">合计: <span className="font-bold text-red-600">¥{total.toFixed(2)}</span></span>
              <button className="bg-red-600 text-white px-8 py-3 rounded-lg font-semibold hover:bg-red-700">去结算</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ─── 订单中心 ───
function OrdersPage() {
  const orders = [
    { id:1, no:'SC2024010001', items:['AirPods Pro 2'], amount:1899, status:'completed', date:'2024-01-15' },
    { id:2, no:'SC2024010002', items:['Keychron K3','鼠标垫 XL'], amount:587, status:'shipped', date:'2024-01-14' },
    { id:3, no:'SC2024010003', items:['Anker充电宝'], amount:199, status:'pending', date:'2024-01-13' },
  ];
  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <h2 className="text-2xl font-bold mb-6">我的订单</h2>
      <div className="space-y-4">
        {orders.map(o => (
          <div key={o.id} className="bg-white p-6 rounded-xl border">
            <div className="flex items-center justify-between mb-4 pb-4 border-b">
              <div>
                <span className="text-sm text-gray-500">{o.no}</span>
                <span className="text-sm text-gray-400 ml-4">{o.date}</span>
              </div>
              <span className={`px-3 py-1 rounded-full text-xs ${o.status === 'completed' ? 'bg-green-100 text-green-700' : o.status === 'shipped' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'}`}>
                {o.status === 'completed' ? '已完成' : o.status === 'shipped' ? '已发货' : '待付款'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <p className="text-sm text-gray-600">{o.items.join(', ')}</p>
              <span className="font-bold">¥{o.amount}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── 主应用 ───
export default function StoreApp() {
  const [page, setPage] = useState('home');
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState([]);

  const addToCart = (product) => {
    setCart(prev => {
      const existing = prev.find(i => i.id === product.id);
      if (existing) return prev.map(i => i.id === product.id ? { ...i, quantity: i.quantity + 1 } : i);
      return [...prev, { ...product, quantity: 1 }];
    });
  };
  const updateCartQty = (id, qty) => {
    if (qty <= 0) setCart(prev => prev.filter(i => i.id !== id));
    else setCart(prev => prev.map(i => i.id === id ? { ...i, quantity: qty } : i));
  };
  const removeFromCart = (id) => setCart(prev => prev.filter(i => i.id !== id));

  const renderPage = () => {
    switch (page) {
      case 'home': return <HomePage />;
      case 'products': return <ProductsPage />;
      case 'product': return <ProductsPage />;
      case 'cart': return <CartPage />;
      case 'orders': return <OrdersPage />;
      default: return <HomePage />;
    }
  };

  return (
    <StoreContext.Provider value={{ page, setPage, search, setSearch, cart, addToCart, updateCartQty, removeFromCart }}>
      <div className="min-h-screen bg-gray-50">
        <Header />
        <main>{renderPage()}</main>
        <footer className="bg-white border-t mt-12 py-8 text-center text-sm text-gray-500">
          <p> SukCommerce. Built with microservices.</p>
        </footer>
      </div>
    </StoreContext.Provider>
  );
}
