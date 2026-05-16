const { createClient } = require('@supabase/supabase-js');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Error: Faltan variables de entorno SUPABASE_URL o SUPABASE_KEY/SUPABASE_ANON_KEY');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const supabaseAdmin = supabaseServiceKey ? createClient(supabaseUrl, supabaseServiceKey) : supabase;
if (!supabaseServiceKey) {
  console.warn('⚠️ SUPABASE_SERVICE_ROLE_KEY no configurada. Usando anon key para admin. Algunas operaciones pueden fallar por RLS.');
}
const dbClient = supabaseAdmin;

const db = {
  // ========== STORAGE ==========
  async uploadImage(filePath, telegramId) {
    try {
      const fileBuffer = await fs.readFile(filePath);
      const fileName = `screenshot_${telegramId}_${Date.now()}.jpg`;
      const { data, error } = await supabaseAdmin.storage
        .from('payments-screenshots')
        .upload(fileName, fileBuffer, { contentType: 'image/jpeg', cacheControl: '3600', upsert: false });
      if (error) throw error;
      const { data: { publicUrl } } = supabaseAdmin.storage.from('payments-screenshots').getPublicUrl(fileName);
      return publicUrl;
    } catch (error) {
      console.error('❌ Error en uploadImage:', error);
      throw error;
    }
  },

  async uploadPlanFile(fileBuffer, plan, originalFileName) {
    try {
      const bucket = plan === 'trial' ? 'trial-files' : 'plan-files';
      const extension = path.extname(originalFileName).toLowerCase();
      let contentType = 'application/octet-stream';
      if (extension === '.conf') contentType = 'text/plain';
      if (extension === '.zip') contentType = 'application/zip';
      if (extension === '.rar') contentType = 'application/x-rar-compressed';
      const storageFileName = originalFileName;
      const { data, error } = await supabaseAdmin.storage
        .from(bucket)
        .upload(storageFileName, fileBuffer, { contentType, cacheControl: '3600', upsert: true });
      if (error) throw error;
      const { data: { publicUrl } } = supabaseAdmin.storage.from(bucket).getPublicUrl(storageFileName);
      return { filename: storageFileName, publicUrl, originalName: originalFileName };
    } catch (error) {
      console.error('❌ Error en uploadPlanFile:', error);
      throw error;
    }
  },

  async deleteOldPlanFile(oldFileName) {
    try {
      if (!oldFileName) return;
      await supabaseAdmin.storage.from('plan-files').remove([oldFileName]);
    } catch (error) {
      console.error('❌ Error en deleteOldPlanFile:', error);
    }
  },

  // ========== USUARIOS ==========
  async getUser(telegramId) {
    try {
      const userId = String(telegramId).trim();
      const { data, error } = await dbClient
        .from('users')
        .select('*')
        .eq('telegram_id', userId)
        .maybeSingle();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en getUser:', error);
      return null;
    }
  },

  async saveUser(telegramId, userData) {
    try {
      const userId = String(telegramId).trim();
      const existingUser = await this.getUser(userId);
      if (existingUser) {
        const updateData = { ...userData, updated_at: new Date().toISOString(), last_activity: new Date().toISOString() };
        if (userData.trial_requested && !existingUser.trial_requested) updateData.trial_requested_at = new Date().toISOString();
        if (userData.trial_received && !existingUser.trial_received) updateData.trial_sent_at = new Date().toISOString();
        if (userData.referrer_id && !existingUser.referrer_id) {
          updateData.referrer_id = userData.referrer_id;
          updateData.referrer_username = userData.referrer_username;
        }
        const { data, error } = await dbClient
          .from('users')
          .update(updateData)
          .eq('telegram_id', userId)
          .select()
          .single();
        if (error) throw error;
        return data;
      } else {
        const insertData = {
          telegram_id: userId,
          ...userData,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          last_activity: new Date().toISOString(),
          is_active: userData.is_active !== undefined ? userData.is_active : true
        };
        const { data, error } = await dbClient
          .from('users')
          .insert([insertData])
          .select()
          .single();
        if (error) throw error;
        return data;
      }
    } catch (error) {
      console.error('❌ Error en saveUser:', error);
      throw error;
    }
  },

  async updateUser(telegramId, updateData) {
    try {
      const userId = String(telegramId).trim();
      const { data, error } = await dbClient
        .from('users')
        .update({ ...updateData, updated_at: new Date().toISOString() })
        .eq('telegram_id', userId)
        .select()
        .single();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en updateUser:', error);
      throw error;
    }
  },

  async updateUserActiveStatus(telegramId, isActive, lastError = null) {
    const updateData = { is_active: isActive, updated_at: new Date().toISOString() };
    if (lastError) updateData.last_error = lastError;
    return await this.updateUser(telegramId, updateData);
  },

  async acceptTerms(telegramId) {
    return await this.saveUser(telegramId, { accepted_terms: true, terms_date: new Date().toISOString() });
  },

  async makeUserVIP(telegramId, vipData = {}) {
    try {
      const userId = String(telegramId).trim();
      const { data, error } = await dbClient
        .from('users')
        .update({
          vip: true,
          plan: vipData.plan || 'vip',
          plan_price: vipData.plan_price || 0,
          vip_since: vipData.vip_since || new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('telegram_id', userId)
        .select()
        .single();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en makeUserVIP:', error);
      throw error;
    }
  },

  async removeVIP(telegramId) {
    try {
      const userId = String(telegramId).trim();
      const { data, error } = await dbClient
        .from('users')
        .update({ vip: false, plan: null, plan_price: null, vip_since: null, updated_at: new Date().toISOString() })
        .eq('telegram_id', userId)
        .select()
        .single();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en removeVIP:', error);
      throw error;
    }
  },

  async getTotalUsersCount() {
    try {
      const { count, error } = await dbClient
        .from('users')
        .select('*', { count: 'exact', head: true });
      if (error) throw error;
      return count || 0;
    } catch (error) {
      console.error('❌ Error en getTotalUsersCount:', error);
      return 0;
    }
  },

  async getAllUsers(limit = 100, offset = 0) {
    try {
      const safeLimit = Math.min(limit, 1000);
      const { data, error } = await dbClient
        .from('users')
        .select('*')
        .order('created_at', { ascending: false })
        .range(offset, offset + safeLimit - 1);
      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('❌ Error en getAllUsers:', error);
      return [];
    }
  },

  async getVIPUsers() {
    try {
      const { data, error } = await dbClient
        .from('users')
        .select('*')
        .eq('vip', true)
        .order('vip_since', { ascending: false });
      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('❌ Error en getVIPUsers:', error);
      return [];
    }
  },

  async getActiveUsers(days = 30) {
    try {
      const date = new Date();
      date.setDate(date.getDate() - days);
      const { data, error } = await dbClient
        .from('users')
        .select('*')
        .gte('last_activity', date.toISOString())
        .order('last_activity', { ascending: false });
      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('❌ Error en getActiveUsers:', error);
      return [];
    }
  },

  // ========== REFERIDOS ==========
  async createReferral(referrerId, referredId, referredUsername = null, referredName = null) {
    try {
      const referrerIdStr = String(referrerId).trim();
      const referredIdStr = String(referredId).trim();
      const { data: existing } = await dbClient
        .from('referrals')
        .select('id')
        .eq('referrer_id', referrerIdStr)
        .eq('referred_id', referredIdStr)
        .maybeSingle();
      if (existing) return existing;
      const { data, error } = await dbClient
        .from('referrals')
        .insert([{
          referrer_id: referrerIdStr,
          referred_id: referredIdStr,
          referred_username: referredUsername,
          referred_name: referredName,
          level: 1,
          has_paid: false,
          created_at: new Date().toISOString()
        }])
        .select()
        .single();
      if (error) throw error;
      // Nivel 2
      const { data: referrerReferrals } = await dbClient
        .from('referrals')
        .select('referrer_id')
        .eq('referred_id', referrerIdStr)
        .eq('level', 1)
        .maybeSingle();
      if (referrerReferrals && referrerReferrals.referrer_id) {
        await dbClient
          .from('referrals')
          .insert([{
            referrer_id: referrerReferrals.referrer_id,
            referred_id: referredIdStr,
            referred_username: referredUsername,
            referred_name: referredName,
            level: 2,
            has_paid: false,
            created_at: new Date().toISOString()
          }]);
      }
      return data;
    } catch (error) {
      console.error('❌ Error en createReferral:', error);
      throw error;
    }
  },

  async getReferralStats(telegramId) {
    try {
      const userId = String(telegramId).trim();
      const { data: level1, error: error1 } = await dbClient
        .from('referrals')
        .select('*')
        .eq('referrer_id', userId)
        .eq('level', 1);
      const { data: level2, error: error2 } = await dbClient
        .from('referrals')
        .select('*')
        .eq('referrer_id', userId)
        .eq('level', 2);
      const level1Paid = level1?.filter(r => r.has_paid).length || 0;
      const level2Paid = level2?.filter(r => r.has_paid).length || 0;
      const totalReferrals = (level1?.length || 0) + (level2?.length || 0);
      const totalPaid = level1Paid + level2Paid;
      const discount = (level1Paid * 20) + (level2Paid * 10);
      const discountPercentage = discount > 100 ? 100 : discount;
      return {
        level1: { total: level1?.length || 0, paid: level1Paid },
        level2: { total: level2?.length || 0, paid: level2Paid },
        total_referrals: totalReferrals,
        total_paid: totalPaid,
        discount_percentage: discountPercentage,
        paid_referrals: totalPaid
      };
    } catch (error) {
      console.error('❌ Error en getReferralStats:', error);
      return { level1: { total: 0, paid: 0 }, level2: { total: 0, paid: 0 }, total_referrals: 0, total_paid: 0, discount_percentage: 0, paid_referrals: 0 };
    }
  },

  async getAllReferralsStats() {
    try {
      const { data: referrals, error } = await dbClient.from('referrals').select('*');
      if (error) throw error;
      
      const referralsArray = referrals || [];
      const referrersMap = new Map();
      
      referralsArray.forEach(r => {
        const id = r.referrer_id;
        if (!referrersMap.has(id)) {
          referrersMap.set(id, { referrer_id: id, total: 0, paid: 0, level1: 0, level2: 0 });
        }
        const stats = referrersMap.get(id);
        stats.total++;
        if (r.has_paid) stats.paid++;
        if (r.level === 1) stats.level1++;
        if (r.level === 2) stats.level2++;
      });
      
      const top_referrers = Array.from(referrersMap.values())
        .sort((a, b) => b.total - a.total)
        .slice(0, 10);
      
      const recent_referrals = [...referralsArray]
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 10);
      
      const total_referrals = referralsArray.length;
      const total_paid = referralsArray.filter(r => r.has_paid).length;
      const level1_referrals = referralsArray.filter(r => r.level === 1).length;
      const level2_referrals = referralsArray.filter(r => r.level === 2).length;
      const paid_level1 = referralsArray.filter(r => r.level === 1 && r.has_paid).length;
      const paid_level2 = referralsArray.filter(r => r.level === 2 && r.has_paid).length;
      
      return {
        total_referrals,
        total_paid,
        top_referrers,
        recent_referrals,
        paid_referrals: total_paid,
        level1_referrals,
        level2_referrals,
        paid_level1,
        paid_level2
      };
    } catch (error) {
      console.error('❌ Error en getAllReferralsStats:', error);
      return {
        total_referrals: 0,
        total_paid: 0,
        top_referrers: [],
        recent_referrals: [],
        paid_referrals: 0,
        level1_referrals: 0,
        level2_referrals: 0,
        paid_level1: 0,
        paid_level2: 0
      };
    }
  },

  async markReferralAsPaid(referredId, level = 1) {
    try {
      const userId = String(referredId).trim();
      const { data, error } = await dbClient
        .from('referrals')
        .update({ has_paid: true })
        .eq('referred_id', userId)
        .select();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en markReferralAsPaid:', error);
      throw error;
    }
  },

  async getReferralsByReferrer(referrerId) {
    try {
      const userId = String(referrerId).trim();
      const { data, error } = await dbClient
        .from('referrals')
        .select('*')
        .eq('referrer_id', userId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('❌ Error en getReferralsByReferrer:', error);
      return [];
    }
  },

  // ========== PAGOS ==========
  async createPayment(paymentData) {
    try {
      const telegramId = String(paymentData.telegram_id).trim();
      const { data, error } = await dbClient
        .from('payments')
        .insert([{
          telegram_id: telegramId,
          plan: paymentData.plan,
          price: paymentData.price,
          original_price: paymentData.original_price || paymentData.price,
          method: paymentData.method || 'transfer',
          screenshot_url: paymentData.screenshot_url || '',
          notes: paymentData.notes || '',
          status: paymentData.status || 'pending',
          coupon_used: paymentData.coupon_used || false,
          coupon_code: paymentData.coupon_code || null,
          coupon_discount: paymentData.coupon_discount || 0,
          created_at: paymentData.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString()
        }])
        .select()
        .single();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en createPayment:', error);
      throw error;
    }
  },

  async getPayment(paymentId) {
    try {
      const { data, error } = await dbClient
        .from('payments')
        .select('*')
        .eq('id', paymentId)
        .maybeSingle();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en getPayment:', error);
      return null;
    }
  },

  async getPendingPayments() {
    try {
      const { data, error } = await dbClient
        .from('payments')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('❌ Error en getPendingPayments:', error);
      return [];
    }
  },

  async getApprovedPayments() {
    try {
      const { data, error } = await dbClient
        .from('payments')
        .select('*')
        .eq('status', 'approved')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('❌ Error en getApprovedPayments:', error);
      return [];
    }
  },

  async approvePayment(paymentId) {
    try {
      const { data, error } = await dbClient
        .from('payments')
        .update({ status: 'approved', approved_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', paymentId)
        .select()
        .single();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en approvePayment:', error);
      throw error;
    }
  },

  async rejectPayment(paymentId, reason) {
    try {
      const { data, error } = await dbClient
        .from('payments')
        .update({ status: 'rejected', rejected_reason: reason, rejected_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', paymentId)
        .select()
        .single();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en rejectPayment:', error);
      throw error;
    }
  },

  async updatePayment(paymentId, updateData) {
    try {
      const { data, error } = await dbClient
        .from('payments')
        .update({ ...updateData, updated_at: new Date().toISOString() })
        .eq('id', paymentId)
        .select()
        .single();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en updatePayment:', error);
      throw error;
    }
  },

  async getUserPayments(telegramId) {
    try {
      const userId = String(telegramId).trim();
      const { data, error } = await dbClient
        .from('payments')
        .select('*')
        .eq('telegram_id', userId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('❌ Error en getUserPayments:', error);
      return [];
    }
  },

  // ========== PAGOS USDT ==========
  async createUsdtPayment(usdtData) {
    try {
      const { data, error } = await dbClient
        .from('usdt_payments')
        .insert([{ ...usdtData, status: 'pending', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }])
        .select()
        .single();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en createUsdtPayment:', error);
      throw error;
    }
  },

  async getUsdtPaymentByAddress(address) {
    try {
      const { data, error } = await dbClient
        .from('usdt_payments')
        .select('*')
        .eq('usdt_address', address)
        .maybeSingle();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en getUsdtPaymentByAddress:', error);
      return null;
    }
  },

  async updateUsdtPaymentStatus(address, status, transactionHash = null, sender = null) {
    try {
      const updateData = { status, updated_at: new Date().toISOString() };
      if (transactionHash) updateData.transaction_hash = transactionHash;
      if (sender) updateData.sender_address = sender;
      if (status === 'completed') updateData.completed_at = new Date().toISOString();
      const { data, error } = await dbClient
        .from('usdt_payments')
        .update(updateData)
        .eq('usdt_address', address)
        .select()
        .single();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en updateUsdtPaymentStatus:', error);
      throw error;
    }
  },

  // ========== ARCHIVOS DE PLANES ==========
  async savePlanFile(planFileData) {
    try {
      const { data: existing } = await dbClient
        .from('plan_files')
        .select('*')
        .eq('plan', planFileData.plan)
        .maybeSingle();
      if (existing) {
        if (planFileData.plan === 'trial' && existing.storage_filename) {
          await supabaseAdmin.storage.from('trial-files').remove([existing.storage_filename]).catch(e => console.warn);
        }
        const { data, error } = await dbClient
          .from('plan_files')
          .update({ ...planFileData, updated_at: new Date().toISOString() })
          .eq('plan', planFileData.plan)
          .select()
          .single();
        if (error) throw error;
        return data;
      } else {
        const { data, error } = await dbClient
          .from('plan_files')
          .insert([{ ...planFileData, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }])
          .select()
          .single();
        if (error) throw error;
        return data;
      }
    } catch (error) {
      console.error('❌ Error en savePlanFile:', error);
      throw error;
    }
  },

  async getPlanFile(plan) {
    try {
      const { data, error } = await dbClient
        .from('plan_files')
        .select('*')
        .eq('plan', plan)
        .maybeSingle();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en getPlanFile:', error);
      return null;
    }
  },

  async getAllPlanFiles() {
    try {
      const { data, error } = await dbClient
        .from('plan_files')
        .select('*')
        .order('plan', { ascending: true });
      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('❌ Error en getAllPlanFiles:', error);
      return [];
    }
  },

  async deletePlanFile(plan) {
    try {
      const fileData = await this.getPlanFile(plan);
      if (fileData && fileData.storage_filename) {
        const bucket = plan === 'trial' ? 'trial-files' : 'plan-files';
        await supabaseAdmin.storage.from(bucket).remove([fileData.storage_filename]).catch(e => console.warn);
      }
      const { data, error } = await dbClient
        .from('plan_files')
        .delete()
        .eq('plan', plan)
        .select()
        .single();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en deletePlanFile:', error);
      throw error;
    }
  },

  // ========== ESTADÍSTICAS ==========
  async getStats() {
    try {
      const [
        { count: totalUsers },
        { count: vipUsers },
        { count: trialRequests },
        { count: trialReceived },
        { count: usersWithReferrer },
        { count: activeUsers },
        { count: inactiveUsers }
      ] = await Promise.all([
        dbClient.from('users').select('*', { count: 'exact', head: true }),
        dbClient.from('users').select('*', { count: 'exact', head: true }).eq('vip', true),
        dbClient.from('users').select('*', { count: 'exact', head: true }).eq('trial_requested', true),
        dbClient.from('users').select('*', { count: 'exact', head: true }).eq('trial_received', true),
        dbClient.from('users').select('*', { count: 'exact', head: true }).not('referrer_id', 'is', null),
        dbClient.from('users').select('*', { count: 'exact', head: true }).eq('is_active', true),
        dbClient.from('users').select('*', { count: 'exact', head: true }).eq('is_active', false)
      ]);

      const { data: paymentsData, error: paymentsError } = await dbClient
        .from('payments')
        .select('status, price, method, coupon_used, coupon_code, coupon_discount, original_price');
      if (paymentsError) throw paymentsError;

      const totalPayments = paymentsData?.length || 0;
      const pendingPayments = paymentsData?.filter(p => p.status === 'pending')?.length || 0;
      const approvedPayments = paymentsData?.filter(p => p.status === 'approved')?.length || 0;
      const rejectedPayments = paymentsData?.filter(p => p.status === 'rejected')?.length || 0;
      const usdtPayments = paymentsData?.filter(p => p.method === 'usdt')?.length || 0;
      const couponPayments = paymentsData?.filter(p => p.coupon_used)?.length || 0;

      const totalRevenue = paymentsData
        ?.filter(p => p.status === 'approved' && p.price)
        ?.reduce((sum, p) => sum + (parseFloat(p.price) || 0), 0) || 0;

      const totalDiscounts = paymentsData
        ?.filter(p => p.status === 'approved' && p.coupon_discount && p.price)
        ?.reduce((sum, p) => {
          const originalPrice = p.original_price || p.price / (1 - (p.coupon_discount / 100));
          const discountAmount = originalPrice - parseFloat(p.price);
          return sum + discountAmount;
        }, 0) || 0;

      let referralsStats = {
        total_referrals: 0,
        total_paid: 0,
        top_referrers: [],
        recent_referrals: [],
        paid_referrals: 0,
        level1_referrals: 0,
        level2_referrals: 0,
        paid_level1: 0,
        paid_level2: 0
      };
      try {
        referralsStats = await this.getAllReferralsStats();
      } catch (refErr) {
        console.error('❌ Error obteniendo stats de referidos (no crítico):', refErr.message);
      }

      const { data: usdtData } = await dbClient.from('usdt_payments').select('status');
      const totalUsdtPayments = usdtData?.length || 0;
      const pendingUsdt = usdtData?.filter(p => p.status === 'pending')?.length || 0;
      const completedUsdt = usdtData?.filter(p => p.status === 'completed')?.length || 0;

      const { data: broadcastsData } = await dbClient.from('broadcasts').select('status');
      const totalBroadcasts = broadcastsData?.length || 0;
      const completedBroadcasts = broadcastsData?.filter(b => b.status === 'completed')?.length || 0;

      const couponsStats = await this.getCouponsStats();

      return {
        users: {
          total: totalUsers || 0,
          vip: vipUsers || 0,
          regular: (totalUsers || 0) - (vipUsers || 0),
          trial_requests: trialRequests || 0,
          trial_received: trialReceived || 0,
          trial_pending: (trialRequests || 0) - (trialReceived || 0),
          with_referrer: usersWithReferrer || 0,
          active: activeUsers || 0,
          inactive: inactiveUsers || 0
        },
        payments: {
          total: totalPayments,
          pending: pendingPayments,
          approved: approvedPayments,
          rejected: rejectedPayments,
          usdt: usdtPayments,
          with_coupon: couponPayments
        },
        revenue: {
          total: totalRevenue,
          discounts: totalDiscounts,
          average: approvedPayments > 0 ? totalRevenue / approvedPayments : 0
        },
        referrals: referralsStats,
        usdt: {
          total: totalUsdtPayments,
          pending: pendingUsdt,
          completed: completedUsdt
        },
        broadcasts: {
          total: totalBroadcasts,
          completed: completedBroadcasts
        },
        coupons: couponsStats
      };
    } catch (error) {
      console.error('❌ Error en getStats:', error);
      return {
        users: { total: 0, vip: 0, regular: 0, trial_requests: 0, trial_received: 0, trial_pending: 0, with_referrer: 0, active: 0, inactive: 0 },
        payments: { total: 0, pending: 0, approved: 0, rejected: 0, usdt: 0, with_coupon: 0 },
        revenue: { total: 0, discounts: 0, average: 0 },
        referrals: { total_referrals: 0, total_paid: 0, top_referrers: [], recent_referrals: [], paid_referrals: 0, level1_referrals: 0, level2_referrals: 0, paid_level1: 0, paid_level2: 0 },
        usdt: { total: 0, pending: 0, completed: 0 },
        broadcasts: { total: 0, completed: 0 },
        coupons: { total: 0, active: 0, expired: 0, used: 0, average_discount: 0, low_stock: 0, out_of_stock: 0, coupons: [] }
      };
    }
  },

  // ========== PRUEBAS GRATUITAS ==========
  async getTrialStats() {
    try {
      const { data, error } = await dbClient
        .from('users')
        .select('trial_requested, trial_received, trial_requested_at, trial_sent_at, trial_plan_type')
        .eq('trial_requested', true);
      if (error) throw error;
      const totalRequests = data?.length || 0;
      const completedTrials = data?.filter(u => u.trial_received)?.length || 0;
      const pendingTrials = totalRequests - completedTrials;
      const today = new Date().toISOString().split('T')[0];
      const todayRequests = data?.filter(u => u.trial_requested_at && u.trial_requested_at.startsWith(today))?.length || 0;
      const trialByType = {
        '1h': data?.filter(u => u.trial_plan_type === '1h')?.length || 0,
        '24h': data?.filter(u => u.trial_plan_type === '24h')?.length || 0
      };
      return { total_requests: totalRequests, completed: completedTrials, pending: pendingTrials, today_requests: todayRequests, by_type: trialByType };
    } catch (error) {
      console.error('❌ Error en getTrialStats:', error);
      return { total_requests: 0, completed: 0, pending: 0, today_requests: 0, by_type: {} };
    }
  },

  async getPendingTrials() {
    try {
      const { data, error } = await dbClient
        .from('users')
        .select('*')
        .eq('trial_requested', true)
        .eq('trial_received', false)
        .order('trial_requested_at', { ascending: true });
      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('❌ Error en getPendingTrials:', error);
      return [];
    }
  },

  async markTrialAsSent(telegramId, sentBy) {
    try {
      const userId = String(telegramId).trim();
      const { data, error } = await dbClient
        .from('users')
        .update({
          trial_received: true,
          trial_sent_at: new Date().toISOString(),
          trial_sent_by: sentBy,
          updated_at: new Date().toISOString()
        })
        .eq('telegram_id', userId)
        .select()
        .single();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en markTrialAsSent:', error);
      throw error;
    }
  },

  async checkTrialEligibility(telegramId) {
    try {
      const user = await this.getUser(telegramId);
      if (!user) return { eligible: true, reason: 'Nuevo usuario' };
      if (!user.trial_requested) return { eligible: true, reason: 'Primera solicitud' };
      if (user.trial_requested && !user.trial_received) return { eligible: false, reason: 'Ya tiene una solicitud pendiente' };
      if (user.trial_received && user.trial_sent_at) {
        const lastTrialDate = new Date(user.trial_sent_at);
        const now = new Date();
        const daysSinceLastTrial = Math.floor((now - lastTrialDate) / (1000 * 60 * 60 * 24));
        if (daysSinceLastTrial < 30) {
          return { eligible: false, reason: `Debe esperar ${30 - daysSinceLastTrial} días para solicitar otra prueba`, days_remaining: 30 - daysSinceLastTrial };
        }
      }
      return { eligible: true, reason: 'Puede solicitar nueva prueba' };
    } catch (error) {
      console.error('❌ Error en checkTrialEligibility:', error);
      return { eligible: false, reason: 'Error verificando elegibilidad' };
    }
  },

  // ========== BROADCASTS ==========
  async createBroadcast(message, targetUsers = 'all', sentBy) {
    try {
      const { data, error } = await dbClient
        .from('broadcasts')
        .insert([{
          message,
          target_users: targetUsers,
          sent_by: sentBy,
          status: 'pending',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }])
        .select()
        .single();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en createBroadcast:', error);
      throw error;
    }
  },

  async getBroadcasts(limit = 50) {
    try {
      const { data, error } = await dbClient
        .from('broadcasts')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('❌ Error en getBroadcasts:', error);
      return [];
    }
  },

  async getBroadcast(broadcastId) {
    try {
      const { data, error } = await dbClient
        .from('broadcasts')
        .select('*')
        .eq('id', parseInt(broadcastId))
        .maybeSingle();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en getBroadcast:', error);
      return null;
    }
  },

  async updateBroadcastStatus(broadcastId, status, stats = {}) {
    try {
      const updateData = { status, updated_at: new Date().toISOString() };
      if (status === 'completed' || status === 'failed') {
        updateData.completed_at = new Date().toISOString();
        updateData.sent_count = stats.sent_count || 0;
        updateData.failed_count = stats.failed_count || 0;
        updateData.total_users = stats.total_users || 0;
        updateData.unavailable_count = stats.unavailable_count || 0;
      } else if (status === 'sending') {
        updateData.sent_count = stats.sent_count || 0;
        updateData.total_users = stats.total_users || 0;
        updateData.failed_count = stats.failed_count || 0;
        updateData.unavailable_count = stats.unavailable_count || 0;
      }
      const { data, error } = await dbClient
        .from('broadcasts')
        .update(updateData)
        .eq('id', broadcastId)
        .select()
        .single();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en updateBroadcastStatus:', error);
      throw error;
    }
  },

  async getUsersForBroadcast(targetUsers = 'all') {
    try {
      let query = dbClient.from('users').select('telegram_id, username, first_name, vip, trial_requested, trial_received, last_activity, is_active');
      if (targetUsers === 'vip') query = query.eq('vip', true);
      else if (targetUsers === 'non_vip') query = query.eq('vip', false);
      else if (targetUsers === 'trial_pending') query = query.eq('trial_requested', true).eq('trial_received', false);
      else if (targetUsers === 'trial_received') query = query.eq('trial_received', true);
      else if (targetUsers === 'active') {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        query = query.gte('last_activity', thirtyDaysAgo.toISOString());
      }
      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('❌ Error en getUsersForBroadcast:', error);
      return [];
    }
  },

  async retryFailedBroadcast(broadcastId) {
    try {
      const { data, error } = await dbClient
        .from('broadcasts')
        .update({ status: 'pending', updated_at: new Date().toISOString() })
        .eq('id', broadcastId)
        .select()
        .single();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en retryFailedBroadcast:', error);
      throw error;
    }
  },

  // ========== CUPONES ==========
  async createCoupon(couponData) {
    try {
      const { data, error } = await dbClient
        .from('coupons')
        .insert([{
          code: couponData.code,
          discount: couponData.discount,
          stock: couponData.stock,
          expiry: couponData.expiry || null,
          description: couponData.description || '',
          status: couponData.status || 'active',
          used: 0,
          created_by: couponData.created_by || 'system',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }])
        .select()
        .single();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en createCoupon:', error);
      throw error;
    }
  },

  async getCoupons() {
    try {
      const { data, error } = await dbClient
        .from('coupons')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('❌ Error en getCoupons:', error);
      return [];
    }
  },

  async getCoupon(code) {
    try {
      const { data, error } = await dbClient
        .from('coupons')
        .select('*')
        .eq('code', code.toUpperCase())
        .maybeSingle();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en getCoupon:', error);
      return null;
    }
  },

  async getCouponsStats() {
    try {
      const { data, error } = await dbClient.from('coupons').select('*');
      if (error) throw error;
      const total = data?.length || 0;
      const active = data?.filter(c => c.status === 'active').length || 0;
      const expired = data?.filter(c => c.status === 'expired').length || 0;
      const inactive = data?.filter(c => c.status === 'inactive').length || 0;
      const used = data?.reduce((sum, c) => sum + (c.used || 0), 0);
      const averageDiscount = data?.length > 0 ? data.reduce((sum, c) => sum + (c.discount || 0), 0) / data.length : 0;
      const lowStock = data?.filter(c => c.stock < 5 && c.stock > 0).length || 0;
      const outOfStock = data?.filter(c => c.stock === 0).length || 0;
      return {
        total,
        active,
        expired,
        inactive,
        used,
        average_discount: averageDiscount.toFixed(1),
        low_stock: lowStock,
        out_of_stock: outOfStock,
        coupons: data || []
      };
    } catch (error) {
      console.error('❌ Error en getCouponsStats:', error);
      return {
        total: 0,
        active: 0,
        expired: 0,
        inactive: 0,
        used: 0,
        average_discount: '0',
        low_stock: 0,
        out_of_stock: 0,
        coupons: []
      };
    }
  },

  async updateCoupon(code, updateData) {
    try {
      const { data, error } = await dbClient
        .from('coupons')
        .update({ ...updateData, updated_at: new Date().toISOString() })
        .eq('code', code.toUpperCase())
        .select()
        .single();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en updateCoupon:', error);
      throw error;
    }
  },

  async updateCouponStatus(code, status, updatedBy) {
    try {
      const { data, error } = await dbClient
        .from('coupons')
        .update({ status, updated_by: updatedBy, updated_at: new Date().toISOString() })
        .eq('code', code.toUpperCase())
        .select()
        .single();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en updateCouponStatus:', error);
      throw error;
    }
  },

  async deleteCoupon(code) {
    try {
      const { data, error } = await dbClient
        .from('coupons')
        .delete()
        .eq('code', code.toUpperCase())
        .select()
        .single();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en deleteCoupon:', error);
      throw error;
    }
  },

  async hasUserUsedCoupon(telegramId, code) {
    try {
      const userId = String(telegramId).trim();
      const couponCode = code.toUpperCase();
      const { data, error } = await dbClient
        .from('coupon_usage')
        .select('id')
        .eq('telegram_id', userId)
        .eq('coupon_code', couponCode)
        .maybeSingle();
      if (error) throw error;
      return !!data;
    } catch (error) {
      console.error('❌ Error en hasUserUsedCoupon:', error);
      return false;
    }
  },

  async applyCouponToPayment(code, telegramId, paymentId) {
    try {
      const userId = String(telegramId).trim();
      const couponCode = code.toUpperCase();
      const coupon = await this.getCoupon(couponCode);
      if (!coupon || coupon.status !== 'active') throw new Error('Cupón no válido o inactivo');
      if (coupon.stock <= 0) throw new Error('Cupón agotado');
      if (await this.hasUserUsedCoupon(userId, couponCode)) throw new Error('Usuario ya usó este cupón');
      
      const { data, error } = await dbClient
        .from('coupon_usage')
        .insert([{
          coupon_code: couponCode,
          telegram_id: userId,
          payment_id: paymentId,
          discount_applied: coupon.discount,
          used_at: new Date().toISOString()
        }])
        .select()
        .single();
      if (error) throw error;
      
      await this.updateCoupon(couponCode, {
        stock: coupon.stock - 1,
        used: (coupon.used || 0) + 1,
        updated_at: new Date().toISOString(),
        updated_by: 'system'
      });
      return data;
    } catch (error) {
      console.error('❌ Error en applyCouponToPayment:', error);
      throw error;
    }
  },

  async getCouponUsageHistory(code) {
    try {
      const couponCode = code.toUpperCase();
      const { data, error } = await dbClient
        .from('coupon_usage')
        .select(`
          *,
          payments:payment_id (id, plan, price, original_price, method, status, created_at),
          users:telegram_id (telegram_id, username, first_name)
        `)
        .eq('coupon_code', couponCode)
        .order('used_at', { ascending: false });
      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('❌ Error en getCouponUsageHistory:', error);
      return [];
    }
  },

  // ========== POOL DE ARCHIVOS DE PRUEBA ==========
  async getTrialFiles() {
    try {
      const { data, error } = await dbClient
        .from('trial_files')
        .select('*')
        .order('uploaded_at', { ascending: false });
      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('❌ Error en getTrialFiles:', error);
      return [];
    }
  },

  async getTrialFile(id) {
    try {
      const { data, error } = await dbClient
        .from('trial_files')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en getTrialFile:', error);
      return null;
    }
  },

  async saveTrialFile(fileData) {
    try {
      const { data, error } = await dbClient
        .from('trial_files')
        .insert([{
          ...fileData,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }])
        .select()
        .single();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en saveTrialFile:', error);
      throw error;
    }
  },

  async updateTrialFile(id, updateData) {
    try {
      const { data, error } = await dbClient
        .from('trial_files')
        .update({ ...updateData, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return data;
    } catch (error) {
      console.error('❌ Error en updateTrialFile:', error);
      throw error;
    }
  },

  async deleteTrialFile(id) {
    try {
      const { error } = await dbClient
        .from('trial_files')
        .delete()
        .eq('id', id);
      if (error) throw error;
      return true;
    } catch (error) {
      console.error('❌ Error en deleteTrialFile:', error);
      return false;
    }
  },

  // ========== OTRAS UTILIDADES ==========
  async searchUsers(searchTerm) {
    try {
      const { data, error } = await dbClient
        .from('users')
        .select('*')
        .or(`telegram_id.ilike.%${searchTerm}%,username.ilike.%${searchTerm}%,first_name.ilike.%${searchTerm}%`)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('❌ Error en searchUsers:', error);
      return [];
    }
  },

  async searchPayments(searchTerm) {
    try {
      const { data, error } = await dbClient
        .from('payments')
        .select('*')
        .or(`id.eq.${searchTerm},telegram_id.ilike.%${searchTerm}%`)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('❌ Error en searchPayments:', error);
      return [];
    }
  },

  async getRecentActivity(limit = 20) {
    try {
      const { data: payments, error: paymentsError } = await dbClient
        .from('payments')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);
      const { data: users, error: usersError } = await dbClient
        .from('users')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(limit);
      if (paymentsError || usersError) throw paymentsError || usersError;
      const activity = [
        ...(payments || []).map(p => ({ type: 'payment', ...p })),
        ...(users || []).map(u => ({ type: 'user', ...u }))
      ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, limit);
      return activity;
    } catch (error) {
      console.error('❌ Error en getRecentActivity:', error);
      return [];
    }
  },

  async getGamesStatistics() {
    try {
      const { data, error } = await dbClient
        .from('users')
        .select('trial_game_server, trial_connection_type, trial_requested_at')
        .eq('trial_requested', true);
      if (error) throw error;
      const gamesMap = new Map();
      const connectionsMap = new Map();
      data?.forEach(user => {
        const game = user.trial_game_server || 'No especificado';
        const connection = user.trial_connection_type || 'No especificado';
        if (!gamesMap.has(game)) gamesMap.set(game, { game, count: 0, lastRequest: user.trial_requested_at });
        const gameData = gamesMap.get(game);
        gameData.count += 1;
        if (user.trial_requested_at && (!gameData.lastRequest || user.trial_requested_at > gameData.lastRequest)) gameData.lastRequest = user.trial_requested_at;
        if (!connectionsMap.has(connection)) connectionsMap.set(connection, { connection, count: 0 });
        connectionsMap.get(connection).count += 1;
      });
      const games = Array.from(gamesMap.values()).sort((a, b) => b.count - a.count);
      const connections = Array.from(connectionsMap.values()).sort((a, b) => b.count - a.count);
      return { games, connections };
    } catch (error) {
      console.error('❌ Error en getGamesStatistics:', error);
      return { games: [], connections: [] };
    }
  },

  async testDatabaseConnection() {
    try {
      const { error: usersError } = await dbClient.from('users').select('count').limit(1);
      const { error: paymentsError } = await dbClient.from('payments').select('count').limit(1);
      const { error: usdtError } = await dbClient.from('usdt_payments').select('count').limit(1);
      const { error: broadcastsError } = await dbClient.from('broadcasts').select('count').limit(1);
      const { error: couponsError } = await dbClient.from('coupons').select('count').limit(1);
      return {
        users: usersError ? `Error: ${usersError.message}` : '✅ Conectado',
        payments: paymentsError ? `Error: ${paymentsError.message}` : '✅ Conectado',
        usdt_payments: usdtError ? `Error: ${usdtError.message}` : '✅ Conectado',
        broadcasts: broadcastsError ? `Error: ${broadcastsError.message}` : '✅ Conectado',
        coupons: couponsError ? `Error: ${couponsError.message}` : '✅ Conectado'
      };
    } catch (error) {
      console.error('❌ Error en testDatabaseConnection:', error);
      return {
        users: `Error: ${error.message}`,
        payments: 'No probado',
        usdt_payments: 'No probado',
        broadcasts: 'No probado',
        coupons: 'No probado'
      };
    }
  }
};

module.exports = db;
