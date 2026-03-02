import { useEffect, useState } from 'react';
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  useNavigate,
} from 'react-router-dom';
import { supabase } from './lib/supabase';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/admin/Dashboard';
import WorkOrderUpload from './pages/admin/WorkOrderUpload';
import Downloads from './pages/admin/Downloads';
import BOMManage from './pages/admin/BOMManage';
import UserManage from './pages/admin/UserManage';
import InventoryUpload from './pages/admin/InventoryUpload';
import ShipmentConfirm from './pages/offline/ShipmentConfirm';
import ReceiptCheck from './pages/playwith/ReceiptCheck';
import MarkingWork from './pages/playwith/MarkingWork';
import type { UserRole, AppUser } from './types';

function AppContent() {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewAs, setViewAs] = useState<UserRole | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    // 5초 타임아웃: getSession이 navigator lock으로 무한 대기하는 경우 방지
    const timeout = setTimeout(() => {
      setLoading(false);
    }, 1000);

    supabase.auth.getSession().then(async ({ data: { session } }) => {
      clearTimeout(timeout);
      if (session) {
        await loadUserProfile(session.user.id, session.user.email || '');
      } else {
        setLoading(false);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        if (event === 'SIGNED_IN' && session) {
          await loadUserProfile(session.user.id, session.user.email || '');
        } else if (event === 'SIGNED_OUT') {
          setUser(null);
          navigate('/login');
        }
      }
    );

    return () => {
      clearTimeout(timeout);
      subscription.unsubscribe();
    };
  }, []);

  const loadUserProfile = async (userId: string, email: string) => {
    const { data: profile } = await supabase
      .from('user_profile')
      .select('*')
      .eq('id', userId)
      .single();

    if (profile) {
      setUser({
        id: userId,
        email,
        role: profile.role as UserRole,
        name: profile.name,
      });

      // 역할별 기본 페이지로 이동
      const defaultPaths: Record<UserRole, string> = {
        admin: '/admin/dashboard',
        offline: '/offline/shipment',
        playwith: '/playwith/receipt',
      };
      navigate(defaultPaths[profile.role as UserRole]);
    } else {
      // 프로필이 없으면 admin 기본값 (첫 사용자)
      setUser({ id: userId, email, role: 'admin', name: email });
      navigate('/admin/dashboard');
    }
    setLoading(false);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="text-gray-400">로딩 중...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  const handleViewAsChange = (role: UserRole | null) => {
    setViewAs(role);
    if (role === 'offline') navigate('/offline/shipment');
    else if (role === 'playwith') navigate('/playwith/receipt');
    else navigate('/admin/dashboard');
  };

  return (
    <Layout
      role={user.role}
      userName={user.name}
      viewAs={viewAs}
      onViewAsChange={handleViewAsChange}
    >
      <Routes>
        {/* 관리자 */}
        <Route path="/admin/dashboard" element={<Dashboard />} />
        <Route path="/admin/workorder" element={<WorkOrderUpload />} />
        <Route path="/admin/downloads" element={<Downloads />} />
        <Route path="/admin/bom" element={<BOMManage />} />
        <Route path="/admin/inventory" element={<InventoryUpload />} />
        <Route path="/admin/users" element={<UserManage />} />

        {/* 오프라인 매장 */}
        <Route path="/offline/shipment" element={<ShipmentConfirm />} />

        {/* 플레이위즈 */}
        <Route path="/playwith/receipt" element={<ReceiptCheck />} />
        <Route path="/playwith/marking" element={<MarkingWork />} />

        {/* 기본 리다이렉트 */}
        <Route
          path="*"
          element={
            <Navigate
              to={
                user.role === 'admin'
                  ? '/admin/dashboard'
                  : user.role === 'offline'
                  ? '/offline/shipment'
                  : '/playwith/receipt'
              }
              replace
            />
          }
        />
      </Routes>
    </Layout>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}
